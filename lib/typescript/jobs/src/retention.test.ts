import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { RETENTION, sweepExpired } from "./retention"

/**
 * Retention, against a real database.
 *
 * The interesting assertions are all about what the sweep leaves alone. Deleting expired rows is
 * easy to write and easy to get right; deleting a row somebody still needs is the failure that
 * matters, and it is silent — nobody notices a missing dead-lettered job until they go looking for
 * why something never ran.
 */
const up = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

const userId = v7()
const ancient = new Date(Date.now() - 400 * 24 * 3600 * 1000)
const recent = new Date(Date.now() - 60 * 1000)

afterAll(async () => {
  if (!up) return
  await db.deleteFrom("session").where("userId", "=", userId).execute()
  await db.deleteFrom("user").where("id", "=", userId).execute()
  await db.destroy()
})

/** An organization to hang OAuth fixtures off. Deleted by the test that made it. */
async function organization(): Promise<string> {
  const id = v7()
  await db
    .insertInto("organization")
    .values({
      id,
      name: "Retention",
      slug: `retention-${id.slice(0, 12)}`,
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  return id
}

describe.skipIf(!up)("the retention policy", () => {
  it("gives every rule a reason, not just a number", () => {
    // A retention period nobody can defend is one that gets changed by whoever finds it
    // inconvenient. The `because` is the review.
    for (const rule of RETENTION) {
      expect(rule.days).toBeGreaterThan(0)
      expect(rule.because.length).toBeGreaterThan(40)
    }
    expect(new Set(RETENTION.map((rule) => rule.label)).size).toBe(RETENTION.length)
  })

  it("deletes a session long past its expiry and keeps a live one", async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `retention-${userId}@example.invalid` })
      .execute()

    const stale = `stale-${userId}`
    const live = `live-${userId}`
    await db
      .insertInto("session")
      .values([
        { sessionKey: stale, userId, expires: ancient, ip: "203.0.113.9" },
        { sessionKey: live, userId, expires: new Date(Date.now() + 3600_000) },
      ])
      .execute()

    await sweepExpired(db)

    const remaining = await db
      .selectFrom("session")
      .select("sessionKey")
      .where("userId", "=", userId)
      .execute()

    // The IP on the stale row was the point: an expired session stops working immediately and its
    // personal data used to sit here indefinitely.
    expect(remaining.map((row) => row.sessionKey)).toEqual([live])
  })

  it("keeps a session inside the grace period", async () => {
    const justExpired = `grace-${userId}`
    await db
      .insertInto("session")
      .values({ sessionKey: justExpired, userId, expires: recent })
      .execute()

    await sweepExpired(db)

    const row = await db
      .selectFrom("session")
      .select("sessionKey")
      .where("sessionKey", "=", justExpired)
      .executeTakeFirst()

    // Expired a minute ago, kept for a week. "Why was I signed out" is answerable from the row.
    expect(row?.sessionKey).toBe(justExpired)
  })

  it("keeps a dead-lettered job and removes a succeeded one", async () => {
    const dead = v7()
    const done = v7()
    await db
      .insertInto("backgroundJob")
      .values([
        { id: dead, kind: "test.retention", state: "dead_lettered", finishedAt: ancient },
        { id: done, kind: "test.retention", state: "succeeded", finishedAt: ancient },
      ])
      .execute()

    await sweepExpired(db)

    const rows = await db
      .selectFrom("backgroundJob")
      .select("id")
      .where("kind", "=", "test.retention")
      .execute()

    /*
      The whole point of the rule. A dead-lettered job is the record of work that failed and was
      never done — the one row someone will come looking for — and it is kept until a human
      resolves it. A sweep keyed on age alone would take it.
    */
    expect(rows.map((row) => row.id)).toEqual([dead])

    await db.deleteFrom("backgroundJob").where("id", "=", dead).execute()
  })

  it("keeps a consumed refresh token until the token itself expires", async () => {
    /*
      Reuse detection reads *consumed* refresh tokens: presenting one twice revokes the family. A
      sweep keyed on `consumed_at` would delete exactly the rows that detection depends on, turning
      a replayed token into an unremarkable "unknown token" — refused, but with no family
      revocation and no signal that anything was stolen.

      So the fixture is the trap itself: consumed long ago, expiring far in the future. It must
      survive, and the assertion at the end is that the one keyed on its own expiry does not.
    */
    const organizationId = await organization()
    const clientId = v7()
    const grantId = v7()

    await db
      .insertInto("oauthClient")
      .values({
        id: clientId,
        organizationId,
        ownerUserId: userId,
        name: "Retention fixture",
        clientType: "confidential",
        homepageUrl: "https://example.invalid",
      })
      .execute()
    await db
      .insertInto("oauthGrant")
      .values({ id: grantId, oauthClientId: clientId, organizationId, userId })
      .execute()

    const consumedButLive = `consumed-live-${grantId}`
    const longExpired = `long-expired-${grantId}`

    await db
      .insertInto("oauthRefreshToken")
      .values([
        {
          tokenHash: consumedButLive,
          oauthGrantId: grantId,
          familyId: v7(),
          consumedAt: ancient,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
        {
          tokenHash: longExpired,
          oauthGrantId: grantId,
          familyId: v7(),
          consumedAt: ancient,
          expiresAt: ancient,
        },
      ])
      .execute()

    await sweepExpired(db)

    const remaining = await db
      .selectFrom("oauthRefreshToken")
      .select("tokenHash")
      .where("oauthGrantId", "=", grantId)
      .execute()

    expect(remaining.map((row) => row.tokenHash)).toEqual([consumedButLive])

    await db.deleteFrom("oauthRefreshToken").where("oauthGrantId", "=", grantId).execute()
    await db.deleteFrom("oauthGrant").where("id", "=", grantId).execute()
    await db.deleteFrom("oauthClient").where("id", "=", clientId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
  })
})
