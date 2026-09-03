import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { crudOauthIdentityFlow } from "./crud"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

describe.runIf(reachable)("OAuth identity flow replay protection", () => {
  const userId = v7()
  const flowId = v7()
  const sessionKey = `identity-session-${v7()}`

  beforeAll(async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.test` })
      .execute()
    await db
      .insertInto("session")
      .values({
        sessionKey,
        userId,
        expires: new Date(Date.now() + 60_000),
        reauthenticatedAt: new Date(),
      })
      .execute()
    await crudOauthIdentityFlow(db).create({
      id: flowId,
      stateHash: `state-${v7()}`,
      userId,
      sessionKey,
      provider: "github",
      intent: "link",
      targetAccountId: null,
      pkceCiphertext: "sealed",
      pkceWrappedDek: "wrapped",
      pkceKmsKeyId: "key",
      returnTo: "/settings",
      expiresAt: new Date(Date.now() + 60_000),
    })
  })

  afterAll(async () => {
    await db.deleteFrom("user").where("id", "=", userId).execute()
    await db.destroy()
  })

  it("consumes state only once and only in the bound session", async () => {
    const wrongSession = await crudOauthIdentityFlow(db).consume(
      (
        await db
          .selectFrom("oauthIdentityFlow")
          .select("stateHash")
          .where("id", "=", flowId)
          .executeTakeFirstOrThrow()
      ).stateHash,
      "another-session",
    )
    expect(wrongSession).toBeUndefined()

    const stateHash = (
      await db
        .selectFrom("oauthIdentityFlow")
        .select("stateHash")
        .where("id", "=", flowId)
        .executeTakeFirstOrThrow()
    ).stateHash
    expect(await crudOauthIdentityFlow(db).consume(stateHash, sessionKey)).toBeDefined()
    expect(await crudOauthIdentityFlow(db).consume(stateHash, sessionKey)).toBeUndefined()
  })
})
