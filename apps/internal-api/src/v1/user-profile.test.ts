import { db } from "@sproutos/db"
import { afterAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
} from "../test/fixtures"

/**
 * The profile screen's two preferences.
 *
 * What is worth testing is the defaults a user who has never opened the screen gets, and that the
 * database — not this service — decides what a timezone is.
 */
const up = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

const userIds: string[] = []

async function person(label: string): Promise<TestUser> {
  const user = await createTestUser(label)
  userIds.push(user.id)
  return user
}

afterAll(async () => {
  if (!up) return
  if (userIds.length > 0) {
    await db.deleteFrom("userPreference").where("userId", "in", userIds).execute()
  }
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("the caller's profile", () => {
  it("has defaults before the screen has ever been opened", async ({ skip }) => {
    if (!up) skip()
    const user = await person("profile-fresh")

    const response = await call("GET", "/v1/user/me/profile", user)
    expect(response.status).toBe(200)
    expect(response.json.timezone).toBe("UTC")
    /*
      Product email defaults to **off**.

      An opt-out default puts the burden of consent on the person who never visited this page, and
      there is no version of that worth the extra open rate.
    */
    expect(response.json.productEmails).toBe(false)
    expect(response.json.email).toBe(user.email)
  })

  it("creates the preference row on first change", async ({ skip }) => {
    if (!up) skip()
    // No row exists until something is set — a row per account holding only defaults would be one
    // more thing for signup to fail at.
    const user = await person("profile-first")
    const before = await db
      .selectFrom("userPreference")
      .select("id")
      .where("userId", "=", user.id)
      .executeTakeFirst()
    expect(before).toBeUndefined()

    const updated = await call("PATCH", "/v1/user/me/profile", user, {
      timezone: "America/New_York",
    })
    expect(updated.status).toBe(200)
    expect(updated.json.timezone).toBe("America/New_York")

    const after = await db
      .selectFrom("userPreference")
      .select("id")
      .where("userId", "=", user.id)
      .executeTakeFirst()
    expect(after).toBeDefined()
  })

  it("updates the row on the second change rather than failing", async ({ skip }) => {
    if (!up) skip()
    const user = await person("profile-twice")
    await call("PATCH", "/v1/user/me/profile", user, { timezone: "Europe/London" })
    const second = await call("PATCH", "/v1/user/me/profile", user, { productEmails: true })

    expect(second.status).toBe(200)
    // The first change survives the second: an upsert that replaced the row would silently reset
    // every other preference on it.
    expect(second.json.timezone).toBe("Europe/London")
    expect(second.json.productEmails).toBe(true)

    const rows = await db
      .selectFrom("userPreference")
      .select("id")
      .where("userId", "=", user.id)
      .execute()
    expect(rows).toHaveLength(1)
  })

  it("refuses a timezone Postgres does not know", async ({ skip }) => {
    if (!up) skip()
    /*
      The database is the authority, because `timezone` reaches `at time zone` in reporting queries
      and an unknown zone there is an error in the middle of a statement rather than a bad row
      anyone can find.
    */
    const user = await person("profile-mars")
    const response = await call("PATCH", "/v1/user/me/profile", user, {
      timezone: "Mars/Olympus",
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(response.json)).toContain("Mars/Olympus")
  })

  it("accepts a name and falls back to the email when there is none", async ({ skip }) => {
    if (!up) skip()
    const user = await person("profile-name")
    const named = await call("PATCH", "/v1/user/me/profile", user, { name: "  Ada Lovelace  " })
    // Trimmed: a name is displayed, and leading whitespace is a rendering bug someone reports.
    expect(named.json.name).toBe("Ada Lovelace")

    await db.updateTable("user").set({ name: null }).where("id", "=", user.id).execute()
    const blank = await call("GET", "/v1/user/me/profile", user)
    // GitHub does not require a display name, so the email is the only thing every account has.
    expect(blank.json.name).toBe(user.email)
  })

  it("treats a request that names nothing as a no-op", async ({ skip }) => {
    if (!up) skip()
    // A PATCH is defined by what it names. Requiring at least one field would make "save" fail on a
    // form nobody edited.
    const user = await person("profile-empty")
    const response = await call("PATCH", "/v1/user/me/profile", user, {})
    expect(response.status).toBe(200)
    expect(response.json.timezone).toBe("UTC")
  })

  it("cannot change anyone else's profile", async ({ skip }) => {
    if (!up) skip()
    // There is no user id in the path — the route acts on the caller and nobody else, which is the
    // property that makes it safe without a permission check.
    const one = await person("profile-one")
    const two = await person("profile-two")

    await call("PATCH", "/v1/user/me/profile", one, { timezone: "Asia/Tokyo" })
    const other = await call("GET", "/v1/user/me/profile", two)
    expect(other.json.timezone).toBe("UTC")
  })

  it("reports the preferences on the preferences route too", async ({ skip }) => {
    if (!up) skip()
    // Two routes reading one row: they must not disagree about what it says.
    const user = await person("profile-both")
    await call("PATCH", "/v1/user/me/profile", user, {
      timezone: "Australia/Sydney",
      productEmails: true,
    })

    const preferences = await call("GET", "/v1/user/me/preferences", user)
    expect(preferences.json.timezone).toBe("Australia/Sydney")
    expect(preferences.json.productEmails).toBe(true)
  })
})
