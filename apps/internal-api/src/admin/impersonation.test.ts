import { db } from "@sproutos/db"
import { afterAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * Impersonation, which is the one feature here where a bug is a privilege escalation.
 *
 * The assertions that matter are all negative: that a chain cannot be built, that an admin cannot
 * be a target, that a support session cannot quietly become a month-long one. Each corresponds to
 * a specific line in `impersonation.ts` or the admin middleware, and each would pass if that line
 * were deleted and only the happy path were tested.
 */
const up = await databaseReachable()

async function admin(label: string): Promise<TestUser> {
  const user = await createTestUser(label)
  await db.updateTable("user").set({ isAdmin: true }).where("id", "=", user.id).execute()
  return user
}

/** One cookie a response set, so a test can act as whoever the API just made it. */
function cookieFrom(response: Response, name: string): string {
  // `getSetCookie`, not `get`: starting an impersonation sets two cookies, and `get("set-cookie")`
  // joins them into one string where a loose regex matches the wrong one.
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header)
    if (match?.[1] !== undefined) return match[1]
  }
  return ""
}

function sessionFrom(response: Response): string {
  return cookieFrom(response, "session")
}

function cookie(token: string): Record<string, string> {
  return { Cookie: `session=${token}`, "Content-Type": "application/json" }
}

const REASON = "Investigating a rendering bug reported in ticket 4471"

afterAll(async () => {
  if (!up) return
  // `session.impersonated_by_user_id` is RESTRICT, like every other reference to `user` — an
  // impersonator who closes their account must not take the evidence with them. The shared
  // teardown deletes users, so the sessions pointing at them have to go first.
  await db.deleteFrom("session").where("impersonatedByUserId", "is not", null).execute()
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("impersonation", () => {
  it("becomes the user, and says so from inside the session", async () => {
    const support = await admin("imp-admin")
    const customer = await createTestUser("imp-customer")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    expect(started.status).toBe(200)

    const token = sessionFrom(started)
    expect(token).not.toBe("")

    const profile = await app.request("/v1/user/me/profile", { headers: cookie(token) })
    expect(((await profile.json()) as { email: string }).email).toBe(customer.email)

    /*
      The banner's data. Someone acting inside an impersonated session has to be able to see that
      they are — an admin who forgets is how a support session becomes an accidental change, and the
      customer's audit trail is the only place that would ever have said so.
    */
    const status = (await (
      await app.request("/v1/user/me/impersonation", { headers: cookie(token) })
    ).json()) as { impersonating: boolean; impersonatorEmail: string | null }

    expect(status.impersonating).toBe(true)
    expect(status.impersonatorEmail).toBe(support.email)
  })

  it("expires in an hour, and the sliding renewal does not extend it", async () => {
    const support = await admin("imp-expiry-admin")
    const customer = await createTestUser("imp-expiry-customer")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    const token = sessionFrom(started)

    /*
      The trap this catches.

      An ordinary session renews when it comes within fifteen days of expiry. An impersonated one is
      issued for sixty minutes — well inside that window — so without an explicit guard the *first*
      authenticated request would extend a stranger's session to thirty days, and nothing about the
      code that set the short expiry would have looked wrong.
    */
    await app.request("/v1/user/me/profile", { headers: cookie(token) })

    const row = await db
      .selectFrom("session")
      .select("expires")
      .where("userId", "=", customer.id)
      .where("impersonatedByUserId", "=", support.id)
      .executeTakeFirstOrThrow()

    const hours = (row.expires.getTime() - Date.now()) / 3_600_000
    expect(hours).toBeLessThan(2)
  })

  it("cannot be chained: an impersonated session is refused by the admin surface", async () => {
    const support = await admin("imp-chain-admin")
    const customer = await createTestUser("imp-chain-customer")
    const third = await createTestUser("imp-chain-third")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    const token = sessionFrom(started)

    /*
      The target is promoted *after* the session was minted.

      This is what makes the assertion mean something. `start` refuses to impersonate an admin, so
      an impersonated session normally belongs to a non-admin and is refused by the `is_admin` check
      alone — a test written without this line passes with the impersonation guard deleted, which is
      the same as not testing it.

      It is also a real state rather than a contrived one: someone can be granted admin while a
      support session against them is open, and at that moment the only thing standing between an
      impersonated cookie and the platform surface is this guard.
    */
    await db.updateTable("user").set({ isAdmin: true }).where("id", "=", customer.id).execute()

    // Refused even for listing: the platform surface is only ever reached by someone signed in as
    // themselves, which is what makes `actor_user_id` on an admin action mean what it says.
    expect((await app.request("/admin/users", { headers: cookie(token) })).status).toBe(403)

    const chained = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: cookie(token),
      body: JSON.stringify({ userId: third.id, reason: REASON }),
    })
    expect(chained.status).toBe(403)

    // And the same cookie still reaches the ordinary product, so the 403 above is the impersonation
    // guard rather than a session that stopped working.
    expect((await app.request("/v1/user/me/profile", { headers: cookie(token) })).status).toBe(200)
  })

  it("refuses to impersonate another admin", async () => {
    const support = await admin("imp-a")
    const other = await admin("imp-b")

    // An admin's session is the one that reaches the platform surface. Impersonating one would
    // borrow that reach while the audit trail named somebody else.
    const refused = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: other.id, reason: REASON }),
    })
    expect(refused.status).toBe(400)
  })

  it("names both people on everything done inside the session", async () => {
    const support = await admin("imp-audit-admin")
    const customer = await createTestUser("imp-audit-customer")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    const token = sessionFrom(started)

    // Something audited, done as the customer while impersonated.
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: cookie(token),
      body: JSON.stringify({ name: "Made While Impersonating" }),
    })
    trackOrganization(((await created.json()) as { id: string }).id)

    const rows = await db
      .selectFrom("auditLog")
      .select(["action", "actorUserId", "impersonatorUserId"])
      .where((eb) =>
        eb.or([eb("actorUserId", "=", customer.id), eb("actorUserId", "=", support.id)]),
      )
      .orderBy("createdAt", "asc")
      .execute()

    // The opening row is the admin acting as themselves: starting an impersonation is their act.
    expect(rows[0]).toMatchObject({
      action: "admin:impersonate:start",
      actorUserId: support.id,
      impersonatorUserId: null,
    })

    /*
      Everything after it is the customer, with the admin recorded alongside. This is what keeps the
      customer's own trail true — without the second column their id would appear against an action
      they did not take, and the one table that exists to answer "who did this" would answer wrongly.
    */
    const work = rows.filter((row) => !row.action.startsWith("admin:impersonate"))
    expect(work.length).toBeGreaterThan(0)
    for (const row of work) {
      expect(row.actorUserId).toBe(customer.id)
      expect(row.impersonatorUserId).toBe(support.id)
    }
  })

  it("hands the admin their own session back when it ends", async () => {
    const support = await admin("imp-end-admin")
    const customer = await createTestUser("imp-end-customer")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    const token = sessionFrom(started)

    /*
      The stashed cookie is what makes this work, and driving the flow in a browser is what showed
      it was needed: there is one `session` cookie, so minting the impersonated one had already
      replaced the admin's, and ending the impersonation signed them out entirely.
    */
    const stash = cookieFrom(started, "impersonator_session")
    expect(stash).toBe(support.sessionToken)

    const ended = await app.request("/v1/user/me/impersonation", {
      method: "DELETE",
      headers: { ...cookie(token), Cookie: `session=${token}; impersonator_session=${stash}` },
    })
    expect(ended.status).toBe(200)

    // The response hands back the admin's own token, so the browser is signed in as them again
    // rather than at a login screen.
    expect(cookieFrom(ended, "session")).toBe(support.sessionToken)

    // Deleted, not expired: a support session that has been ended must not work if the cookie is
    // replayed a second later.
    expect((await app.request("/v1/user/me/profile", { headers: cookie(token) })).status).toBe(401)

    // And that restored token really does reach the platform surface.
    expect(
      (await app.request("/admin/users", { headers: cookie(support.sessionToken) })).status,
    ).toBe(200)
  })

  it("does not restore a stashed session belonging to somebody else", async () => {
    const support = await admin("imp-forge-admin")
    const bystander = await createTestUser("imp-forge-bystander")
    const customer = await createTestUser("imp-forge-customer")

    const started = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(support),
      body: JSON.stringify({ userId: customer.id, reason: REASON }),
    })
    const token = sessionFrom(started)

    /*
      A planted stash grants nothing it did not already grant — it is a session token, and
      presenting it as `session` gives whatever it already gave. What it would do is make the audit
      trail describe a handover that did not happen, so the token is checked against the admin this
      session actually records.
    */
    const ended = await app.request("/v1/user/me/impersonation", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `session=${token}; impersonator_session=${bystander.sessionToken}`,
      },
    })
    expect(ended.status).toBe(200)

    const restored = cookieFrom(ended, "session")
    expect(restored).not.toBe(bystander.sessionToken)
    expect(restored).toBe("")
  })

  it("is refused to someone who is not an admin", async () => {
    const ordinary = await createTestUser("imp-nobody")
    const target = await createTestUser("imp-target")

    expect((await app.request("/admin/users", { headers: authHeaders(ordinary) })).status).toBe(403)

    const refused = await app.request("/admin/users/impersonate", {
      method: "POST",
      headers: authHeaders(ordinary),
      body: JSON.stringify({ userId: target.id, reason: REASON }),
    })
    expect(refused.status).toBe(403)
  })
})
