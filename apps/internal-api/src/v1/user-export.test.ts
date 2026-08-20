import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  trackOrganization,
} from "../test/fixtures"

/**
 * The right of access.
 *
 * Two things are being checked, and only one of them is "the endpoint returns data". The other is
 * what it must **not** return: an export is a file that leaves our custody by design, so a live
 * credential in it is a credential published. That half is asserted against the raw response body
 * rather than the parsed object, because a secret that leaked through a field nobody declared would
 * be invisible to an assertion that only looked at the fields we expect.
 */
const up = await databaseReachable()

afterAll(async () => {
  if (!up) return
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("exporting your data", () => {
  it("returns the person's own data as a downloadable document", async () => {
    const user = await createTestUser("export-me")

    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: "Export Team" }),
    })
    const organization = (await created.json()) as { id: string; slug: string }
    trackOrganization(organization.id)

    const response = await app.request("/v1/user/me/export", { headers: authHeaders(user) })
    expect(response.status).toBe(200)

    // A browser has to save this rather than render it: the right is satisfied by handing someone
    // a document they keep.
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sproutos-export-\d{4}-\d{2}-\d{2}\.json"$/,
    )

    const document = (await response.json()) as {
      format: string
      profile: { email: string; id: string }
      organizations: { items: Array<{ slug: string; owner: boolean }>; truncated: boolean }
      sessions: { items: unknown[] }
    }

    expect(document.format).toBe("sproutos.user-export.v1")
    expect(document.profile.email).toBe(user.email)
    expect(document.profile.id).toBe(user.id)
    expect(document.organizations.items).toContainEqual(
      expect.objectContaining({ slug: organization.slug, owner: true }),
    )
    expect(document.organizations.truncated).toBe(false)
    // They have one session: the one making this request.
    expect(document.sessions.items).toHaveLength(1)
  })

  it("carries no credential of any kind", async () => {
    const user = await createTestUser("export-secrets")

    // An API key belongs to an organization, so the person needs one before they can hold a key.
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: "Secrets Team" }),
    })
    const organization = (await created.json()) as { id: string; slug: string }
    trackOrganization(organization.id)

    const issued = await app.request(`/v1/orgs/${organization.slug}/api-keys`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: "For the export test", scopes: [] }),
    })
    expect(issued.status).toBe(201)
    // The plaintext key is returned exactly once, at creation. Asserted rather than optional: a
    // response that stopped carrying it would make the leak check below vacuously pass.
    const key = (await issued.json()) as { key: string }
    expect(typeof key.key).toBe("string")

    /*
      A real session token and a real API key exist for this user at this moment. If either appears
      anywhere in the response — declared field or not — the export is a way to exfiltrate
      credentials rather than a way to exercise a right.
    */
    const body = await (
      await app.request("/v1/user/me/export", { headers: authHeaders(user) })
    ).text()

    expect(body).not.toContain(user.sessionToken)
    expect(body).not.toContain(key.key)

    // And the stored forms, which are just as disqualifying: a hash is still the material an
    // offline attack works against.
    const stored = await db
      .selectFrom("session")
      .select("sessionKey")
      .where("userId", "=", user.id)
      .executeTakeFirstOrThrow()
    expect(body).not.toContain(stored.sessionKey)

    const storedKey = await db
      .selectFrom("apiKey")
      .select("keyHash")
      .where("userId", "=", user.id)
      .executeTakeFirstOrThrow()
    expect(body).not.toContain(storedKey.keyHash)
  })

  it("does not hand one member another member's audit trail", async () => {
    const owner = await createTestUser("export-owner")
    const other = await createTestUser("export-other")

    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ name: "Shared Team" }),
    })
    const organization = (await created.json()) as { id: string }
    trackOrganization(organization.id)

    // `other` is in the same organization and did one thing in it. The audit log is the
    // organization's; only the actor's own rows are theirs to export.
    await db
      .insertInto("auditLog")
      .values({
        id: v7(),
        organizationId: organization.id,
        actorUserId: other.id,
        action: "project:create",
        resourceSrn: null,
      })
      .execute()

    const document = (await (
      await app.request("/v1/user/me/export", { headers: authHeaders(owner) })
    ).json()) as { activity: { items: Array<{ action: string }> } }

    expect(document.activity.items.some((row) => row.action === "project:create")).toBe(false)
  })
})
