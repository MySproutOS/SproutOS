/* oxlint-disable no-await-in-loop */
import { resolveAgentCredential } from "@lib/agent"
import { db } from "@sproutos/db"
import { afterAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  kmsReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()
// Storing a credential seals it through KMS, so those tests need LocalStack as well as Postgres.
const kms = await kmsReachable()

afterAll(async () => {
  if (reachable) await cleanupFixtures()
})

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; text: string; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: user === null ? { "Content-Type": "application/json" } : authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, text, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

/**
 * Runs against the compose Postgres and the compose LocalStack KMS. The secret path is the point
 * of this suite, and a faked KMS would not exercise the encryption context that keeps one
 * organization's ciphertext from opening in another's row.
 */
describe.skipIf(!reachable || !kms)("agent credentials", () => {
  const SECRET = "sk-test-abcdefghijklmnop-9999"

  async function orgFor(user: TestUser, name: string): Promise<string> {
    const created = await call("POST", "/v1/orgs", user, { name })
    if (created.status !== 201) throw new Error(`fixture setup failed: ${created.status}`)
    trackOrganization(created.json.id as string)
    return created.json.slug as string
  }

  it("stores a credential and never hands the secret back", async ({ skip }) => {
    if (!reachable) skip()
    const user = await createTestUser("agentowner")
    const slug = await orgFor(user, "Agent Suite")

    const created = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, {
      kind: "anthropic_api_key",
      label: "Primary",
      secret: SECRET,
    })
    expect(created.status).toBe(201)

    // The whole response body, not just the fields we thought to check.
    expect(created.text).not.toContain(SECRET)
    expect(created.text).not.toContain(SECRET.slice(0, 12))

    const listed = await call("GET", `/v1/orgs/${slug}/agent/credentials`, user)
    expect(listed.status).toBe(200)
    expect(listed.text).not.toContain(SECRET)

    const [first] = listed.json.data as { lastFour: string; label: string }[]
    // Enough to tell two keys apart in a list, and nothing more.
    expect(first.lastFour).toBe("9999")
    expect(first.label).toBe("Primary")
  })

  it("edits only the label and leaves the secret usable", async ({ skip }) => {
    if (!reachable) skip()
    const user = await createTestUser("agentrename")
    const slug = await orgFor(user, "Agent Rename")
    const created = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, {
      kind: "anthropic_api_key",
      label: "Before",
      secret: SECRET,
    })
    const credentialId = (created.json.data as { id: string }[])[0].id

    const renamed = await call(
      "PATCH",
      `/v1/orgs/${slug}/agent/credentials/${credentialId}`,
      user,
      { label: "After" },
    )
    expect(renamed.status).toBe(200)
    expect(renamed.json.label).toBe("After")
    expect(renamed.text).not.toContain(SECRET)

    await call("PUT", `/v1/orgs/${slug}/agent/config`, user, { agentCredentialId: credentialId })
    const resolved = await resolveAgentCredential(db, await organizationIdFor(slug))
    expect(resolved.billing).toBe("byo")
    if (resolved.billing !== "byo") throw new Error("unreachable")
    expect(resolved.secret).toBe(SECRET)
  })

  it("round-trips the secret through KMS for the run that needs it", async ({ skip }) => {
    if (!reachable) skip()
    const user = await createTestUser("agentrunner")
    const slug = await orgFor(user, "Agent Runner")

    const created = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, {
      kind: "anthropic_api_key",
      label: "Runner",
      secret: SECRET,
    })
    const credentialId = (created.json.data as { id: string }[])[0].id

    await call("PUT", `/v1/orgs/${slug}/agent/config`, user, {
      agentCredentialId: credentialId,
    })

    const organizationId = await organizationIdFor(slug)
    const resolved = await resolveAgentCredential(db, organizationId)

    expect(resolved.billing).toBe("byo")
    if (resolved.billing !== "byo") throw new Error("unreachable")
    expect(resolved.secret).toBe(SECRET)
  })

  it("refuses a second credential with the same label", async ({ skip }) => {
    if (!reachable) skip()
    const user = await createTestUser("agentdupe")
    const slug = await orgFor(user, "Agent Dupe")

    const body = { kind: "openai_api_key" as const, label: "Same", secret: SECRET }
    expect((await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, body)).status).toBe(201)

    const second = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, body)
    expect(second.status).toBe(400)
  })

  it("refuses a credential belonging to another organization", async ({ skip }) => {
    if (!reachable) skip()
    const owner = await createTestUser("agentmine")
    const stranger = await createTestUser("agenttheirs")
    const mine = await orgFor(owner, "Mine")
    const theirs = await orgFor(stranger, "Theirs")

    const created = await call("POST", `/v1/orgs/${theirs}/agent/credentials`, stranger, {
      kind: "openai_api_key",
      label: "Theirs",
      secret: SECRET,
    })
    const foreignId = (created.json.data as { id: string }[])[0].id

    // The foreign key alone would accept this: it proves the row exists, not that it is ours.
    const attached = await call("PUT", `/v1/orgs/${mine}/agent/config`, owner, {
      agentCredentialId: foreignId,
    })
    expect(attached.status).toBe(400)
  })
})

describe.skipIf(!reachable)("who pays for a run", () => {
  async function setup(label: string) {
    const user = await createTestUser(label)
    const created = await call("POST", "/v1/orgs", user, { name: `Billing ${label}` })
    trackOrganization(created.json.id as string)
    return { user, slug: created.json.slug as string, organizationId: created.json.id as string }
  }

  it("refuses to run with nothing configured", async ({ skip }) => {
    if (!reachable) skip()
    const { organizationId } = await setup("nothing")
    const resolved = await resolveAgentCredential(db, organizationId)
    expect(resolved.billing).toBe("none")
  })

  it("bills credits only when that was asked for explicitly", async ({ skip }) => {
    if (!reachable) skip()
    const { user, slug, organizationId } = await setup("credits")

    expect((await resolveAgentCredential(db, organizationId)).billing).toBe("none")

    await call("PUT", `/v1/orgs/${slug}/agent/config`, user, { useSproutosCredits: true })
    expect((await resolveAgentCredential(db, organizationId)).billing).toBe("platform")
  })

  it("prefers the customer's own credential over their credits", async ({ skip }) => {
    if (!reachable || !kms) skip()
    const { user, slug, organizationId } = await setup("both")

    const created = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, {
      kind: "claude_subscription",
      label: "Subscription",
      secret: "sk-ant-oat-fixture-0001",
    })
    const credentialId = (created.json.data as { id: string }[])[0].id

    await call("PUT", `/v1/orgs/${slug}/agent/config`, user, {
      agentCredentialId: credentialId,
      useSproutosCredits: true,
    })

    // Their key costs them nothing extra; our key spends their balance. With both configured the
    // free one wins.
    expect((await resolveAgentCredential(db, organizationId)).billing).toBe("byo")
  })

  it("stops rather than falling through to credits when a credential is revoked", async ({
    skip,
  }) => {
    if (!reachable || !kms) skip()
    const { user, slug, organizationId } = await setup("revoked")

    const created = await call("POST", `/v1/orgs/${slug}/agent/credentials`, user, {
      kind: "anthropic_api_key",
      label: "Doomed",
      secret: "sk-ant-fixture-doomed-0002",
    })
    const credentialId = (created.json.data as { id: string }[])[0].id

    await call("PUT", `/v1/orgs/${slug}/agent/config`, user, {
      agentCredentialId: credentialId,
      useSproutosCredits: true,
    })

    await call("DELETE", `/v1/orgs/${slug}/agent/credentials/${credentialId}`, user)

    // This is the trap the design exists to avoid: revoking a key must not quietly move the
    // organization onto a metered platform key and start charging them.
    const resolved = await resolveAgentCredential(db, organizationId)
    expect(resolved.billing).toBe("none")
    if (resolved.billing !== "none") throw new Error("unreachable")
    expect(resolved.reason).toBe("revoked")
  })
})

async function organizationIdFor(slug: string): Promise<string> {
  const row = await db
    .selectFrom("organization")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirstOrThrow()
  return row.id
}
