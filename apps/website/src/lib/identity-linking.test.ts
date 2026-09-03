import { randomUUID } from "node:crypto"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { completeIdentityFlow, type ConsumedIdentityFlow } from "./identity-linking"

const databaseUp = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()
const kmsUp = await (async () => {
  try {
    const response = await fetch(
      `${process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"}/_localstack/health`,
      {
        signal: AbortSignal.timeout(1_500),
      },
    )
    return response.ok
  } catch {
    return false
  }
})()

const currentUserId = randomUUID()
const otherUserId = randomUUID()
const sessionKey = `identity-link-${randomUUID()}`
const otherAccountId = randomUUID()

function flow(overrides: Partial<ConsumedIdentityFlow> = {}): ConsumedIdentityFlow {
  return {
    id: randomUUID(),
    userId: currentUserId,
    sessionKey,
    provider: "github",
    intent: "link",
    targetAccountId: null,
    returnTo: "/orgs/example/settings/sign-in-methods",
    verifier: "verifier",
    ...overrides,
  }
}

function tokens(accessToken: string, scopes = ["read:user"]) {
  return {
    accessToken,
    tokenType: "bearer",
    idToken: null,
    refreshToken: null,
    scopes,
    accessTokenExpiresInSeconds: null,
  }
}

describe.runIf(databaseUp)("explicit identity linking", () => {
  beforeAll(async () => {
    process.env.KMS_KEY_ID ??= "alias/sproutos-dev"
    await db
      .insertInto("user")
      .values([
        { id: currentUserId, email: `${currentUserId}@example.test` },
        { id: otherUserId, email: `${otherUserId}@example.test` },
      ])
      .execute()
    await db
      .insertInto("session")
      .values({
        sessionKey,
        userId: currentUserId,
        expires: new Date(Date.now() + 60_000),
      })
      .execute()
    await db
      .insertInto("account")
      .values({
        id: otherAccountId,
        userId: otherUserId,
        type: "oauth",
        provider: "github",
        providerAccountId: "9001",
        displayIdentity: "already-owned",
      })
      .execute()
  })

  afterAll(async () => {
    await db.transaction().execute(async (transaction) => {
      await sql`alter table audit_log disable trigger audit_log_append_only`.execute(transaction)
      await transaction
        .deleteFrom("auditLog")
        .where("actorUserId", "in", [currentUserId, otherUserId])
        .execute()
      await sql`alter table audit_log enable trigger audit_log_append_only`.execute(transaction)
    })
    await db.deleteFrom("user").where("id", "in", [currentUserId, otherUserId]).execute()
    await db.destroy()
  })

  it("refuses a provider identity owned by another user without merging", async () => {
    const response = await completeIdentityFlow({
      flow: flow(),
      provider: "github",
      providerAccountId: "9001",
      displayIdentity: "already-owned",
      tokens: tokens("must-not-be-stored"),
      request: new Request("https://sproutos.test/callback"),
    })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toContain("sign_in_method=conflict")
    expect(
      await db
        .selectFrom("account")
        .select("userId")
        .where("id", "=", otherAccountId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ userId: otherUserId })
    expect(
      await db
        .selectFrom("account")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("userId", "=", currentUserId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" })
  })

  it.skipIf(!kmsUp)("links and reauthorizes one row with sealed token replacement", async () => {
    const linked = await completeIdentityFlow({
      flow: flow(),
      provider: "github",
      providerAccountId: "9002",
      displayIdentity: "first-handle",
      tokens: tokens("first-access-token"),
      request: new Request("https://sproutos.test/callback"),
    })
    expect(linked.headers.get("location")).toContain("sign_in_method=linked")
    const account = await db
      .selectFrom("account")
      .select(["id", "accessTokenCiphertext"])
      .where("userId", "=", currentUserId)
      .executeTakeFirstOrThrow()
    expect(account.accessTokenCiphertext).not.toContain("first-access-token")

    const reauthorized = await completeIdentityFlow({
      flow: flow({ intent: "reauthorize", targetAccountId: account.id }),
      provider: "github",
      providerAccountId: "9002",
      displayIdentity: "renamed-handle",
      tokens: tokens("replacement-access-token", ["repo", "read:user"]),
      request: new Request("https://sproutos.test/callback"),
    })
    expect(reauthorized.headers.get("location")).toContain("sign_in_method=reauthorized")
    const rows = await db
      .selectFrom("account")
      .select(["id", "displayIdentity", "scopes", "accessTokenCiphertext"])
      .where("userId", "=", currentUserId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: account.id,
      displayIdentity: "renamed-handle",
      scopes: ["repo", "read:user"],
    })
    expect(rows[0]?.accessTokenCiphertext).not.toBe(account.accessTokenCiphertext)
    expect(
      await db
        .selectFrom("user")
        .select(["githubLogin", "githubUserId"])
        .where("id", "=", currentUserId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ githubLogin: "renamed-handle", githubUserId: "9002" })
  })
})
