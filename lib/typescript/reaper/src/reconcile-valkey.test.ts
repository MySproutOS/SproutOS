import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  expectedValkeyAclTokens,
  valkeyAclSetUserArgs,
  valkeyAclUsername,
  type ValkeyAclIdentity,
  VALKEY_ACL_POLICY,
} from "@lib/services"
import { reconcileValkeyAclIdentities, valkeyAclTokenDifference } from "./reconcile-valkey"

const ROOT = "r".repeat(32)
const first = identity(1)
const second = identity(2)

class FakeRedis {
  readonly users = new Map<string, string>()
  readonly calls: string[][] = []

  call(...args: (string | Buffer | number)[]): Promise<unknown> {
    const text = args.map(String)
    this.calls.push(text)
    if (text[0] === "ACL" && text[1] === "LIST") {
      return Promise.resolve(["user default on nopass ~* &* +@all", ...this.users.values()])
    }
    if (text[0] === "ACL" && text[1] === "SETUSER") {
      const username = text[2]
      const candidateIdentity = [first, second].find(
        (candidate) => valkeyAclUsername(candidate) === username,
      )
      if (candidateIdentity === undefined) throw new Error(`unknown fixture identity ${username}`)
      this.users.set(username, line(candidateIdentity))
      return Promise.resolve("OK")
    }
    throw new Error(`unexpected call ${text.join(" ")}`)
  }
}

describe("Valkey ACL reconciliation", () => {
  it("reports ACL token differences without exposing password hashes", () => {
    expect(
      valkeyAclTokenDifference("user tenant on #secret +acl", new Set(["on", "#other"])),
    ).toEqual({
      missing: ["#<password-hash>"],
      extra: ["#<password-hash>", "+acl"],
    })
  })

  it("matches the shared Rust credential vector", () => {
    const vector = VALKEY_ACL_POLICY.credentialVector
    const args = valkeyAclSetUserArgs(
      { id: vector.resourceId, organizationId: vector.organizationId },
      vector.rootKey,
    )
    expect(args[0]).toBe(vector.username)
    expect(args).toContain(`>${vector.password}`)
  })

  it("repairs missing and drifted live identities", async () => {
    const redis = new FakeRedis()
    redis.users.set(valkeyAclUsername(second), `${line(second)} +acl`)

    const report = await reconcileValkeyAclIdentities(redis, [first, second], ROOT)

    expect(report).toMatchObject({ missing: 1, drifted: 1, repaired: 2, pendingRepairs: 0 })
    expect(redis.users.get(valkeyAclUsername(first))).toBe(line(first))
    expect(redis.users.get(valkeyAclUsername(second))).toBe(line(second))
  })

  it("reports tenant-shaped orphans without deleting them", async () => {
    const redis = new FakeRedis()
    redis.users.set(valkeyAclUsername(first), line(first))
    redis.users.set(valkeyAclUsername(second), line(second))

    const report = await reconcileValkeyAclIdentities(redis, [first], ROOT)

    expect(report.orphaned).toBe(1)
    expect(redis.calls.some((call) => call.includes("DELUSER"))).toBe(false)
    expect(redis.users.has(valkeyAclUsername(second))).toBe(true)
  })

  it("bounds repair and rotates the bounded inspection window", async () => {
    const redis = new FakeRedis()
    redis.users.set(valkeyAclUsername(first), `${line(first)} +acl`)
    redis.users.set(valkeyAclUsername(second), `${line(second)} +acl`)

    const report = await reconcileValkeyAclIdentities(redis, [first, second], ROOT, {
      repairLimit: 1,
      inspectionLimit: 1,
      inspectionOffset: 1,
    })

    expect(report).toMatchObject({ inspected: 1, drifted: 1, repaired: 1, pendingRepairs: 0 })
    expect(redis.users.get(valkeyAclUsername(first))).toContain("+acl")
    expect(redis.users.get(valkeyAclUsername(second))).toBe(line(second))
  })
})

function identity(value: number): ValkeyAclIdentity {
  const hex = value.toString(16).padStart(12, "0")
  return {
    id: `00000000-0000-0000-0000-${hex}`,
    organizationId: "00000000-0000-0000-0000-000000000099",
  }
}

function line(value: ValkeyAclIdentity): string {
  const username = valkeyAclUsername(value)
  const args = valkeyAclSetUserArgs(value, ROOT)
  const password = args.find((arg) => arg.startsWith(">"))?.slice(1)
  if (password === undefined) throw new Error("fixture password missing")
  const expected = expectedValkeyAclTokens(value, ROOT)
  expect(expected.has(`#${createHash("sha256").update(password).digest("hex")}`)).toBe(true)
  return `user ${username} ${[...expected].join(" ")}`
}
