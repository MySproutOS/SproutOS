import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { expectedValkeyAclTokens, valkeyAclUsername, type ValkeyAclIdentity } from "@lib/services"
import { reconcileValkeyAclIdentities, valkeyAclTokenDifference } from "./reconcile-valkey"

const adminUrl = process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://127.0.0.1:41023"
const redis = new Redis(adminUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  connectTimeout: 1_000,
})
const root = "integration-valkey-acl-root-key-32"
const organizationId = v7()
const identities: ValkeyAclIdentity[] = [
  { id: v7(), organizationId },
  { id: v7(), organizationId },
  { id: v7(), organizationId },
]
let reachable = false

beforeAll(async () => {
  try {
    await redis.connect()
    reachable = true
  } catch {
    if (process.env.CI !== undefined) {
      throw new Error("Valkey ACL reconciliation integration test cannot silently skip in CI")
    }
  }
})

afterAll(async () => {
  if (reachable) {
    await redis.call("ACL", "DELUSER", ...identities.map(valkeyAclUsername))
  }
  redis.disconnect()
})

describe("Valkey ACL reconciliation against a real engine", () => {
  it("repairs missing/drifted users and preserves an orphan", async ({ skip }) => {
    if (!reachable) skip()
    await reconcileValkeyAclIdentities(redis, identities.slice(1), root)
    await redis.call("ACL", "SETUSER", valkeyAclUsername(identities[1]), "+ACL")

    const report = await reconcileValkeyAclIdentities(redis, identities.slice(0, 2), root)

    expect(report).toMatchObject({ missing: 1, drifted: 1, repaired: 2 })
    expect(report.orphaned).toBeGreaterThanOrEqual(1)
    expect(await redis.call("ACL", "GETUSER", valkeyAclUsername(identities[2]))).not.toBeNull()
    const stable = await reconcileValkeyAclIdentities(redis, identities.slice(0, 2), root)
    const lines = (await redis.call("ACL", "LIST")) as string[]
    const diagnostics = identities.slice(0, 2).map((identity) => {
      const username = valkeyAclUsername(identity)
      const line = lines.find((candidate) => candidate.startsWith(`user ${username} `)) ?? ""
      return {
        username,
        ...valkeyAclTokenDifference(line, expectedValkeyAclTokens(identity, root)),
      }
    })
    if (stable.missing !== 0 || stable.drifted !== 0 || stable.repaired !== 0) {
      throw new Error(
        `Valkey ACL reconciliation was not idempotent: ${JSON.stringify(diagnostics)}`,
      )
    }
    expect(stable).toMatchObject({ missing: 0, drifted: 0, repaired: 0 })
    expect(await redis.call("ACL", "GETUSER", valkeyAclUsername(identities[2]))).not.toBeNull()
  })
})
