import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { v7 } from "uuid"

/*
  The App was installed and the platform could not see it.

  `installationSync` drops an installation on an account no organization owns yet, and creating a
  project is not a GitHub event — so installing the App before creating the first project left it
  invisible with nothing scheduled to reconsider. Redelivering the webhook does not help: the
  receiver keys idempotency on `X-GitHub-Delivery` and a redelivery reuses that id, so it is
  discarded as a duplicate of the delivery that ran too early. GitHub answers 200 and nothing runs.

  These assert the mechanism that now closes it, against the one authority on where the App is
  installed. `@lib/github` is faked because the subject is which row appears, not HTTP.
*/
const installations = vi.fn<() => Promise<unknown[]>>()

/*
  Partial, because the row this asserts is written by the real `linkInstallation`.

  Only the calls that would reach GitHub are replaced. Stubbing the whole module would leave the
  test passing against a mock of the very write it exists to check.
*/
vi.mock("@lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/github")>()),
  appJwt: (token: string) => ({ kind: "app", token }),
  createGitHubClient: () => ({
    request: async () => ({ data: await installations() }),
  }),
  envAppJwtSigner: () => () => "signed.app.jwt",
  MissingGitHubAppConfigError: class extends Error {},
}))

const { GITHUB_EVENT_HANDLERS, GITHUB_EVENT_KINDS, installationDiscoveryIdempotencyKey } =
  await import("./github-events")

let reachable = false
let organizationId: string
let ownerUserId: string
let repositoryId: string

/** Deliberately mixed case: GitHub logins are case-insensitive and this column keeps what was typed. */
const LOGIN = "TestSproutOS"
const INSTALLATION_ID = 998_101

const context = () => ({ db, keepAlive: () => Promise.resolve(true) }) as never
const discover = (payload: unknown) =>
  GITHUB_EVENT_HANDLERS[GITHUB_EVENT_KINDS.installationDiscover]({ payload } as never, context())

const stored = async () =>
  await db
    .selectFrom("githubInstallation")
    .select(["organizationId", "accountLogin", "repositorySelection"])
    .where("installationId", "=", String(INSTALLATION_ID))
    .executeTakeFirst()

describe("installation discovery identity", () => {
  it("gets a fresh job when the configured GitHub App changes", () => {
    const first = installationDiscoveryIdempotencyKey({
      appId: "4657519",
      login: "Andrew-Chen-Wang",
      organizationId: "organization",
    })
    const replacement = installationDiscoveryIdempotencyKey({
      appId: "4716574",
      login: "andrew-chen-wang",
      organizationId: "organization",
    })

    expect(first).not.toBe(replacement)
    expect(replacement).toBe("github.installation.discover:4716574:organization:andrew-chen-wang")
  })
})

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  repositoryId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `disc-${ownerUserId}@test.invalid`, name: "Disc" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Discovery Org",
      slug: `disc-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: String(Date.now() % 1_000_000_000),
      ownerLogin: LOGIN,
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "template",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("githubInstallation").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

describe("installation discovery", () => {
  it("links an installation that arrived before the organization owned anything", async ({
    skip,
  }) => {
    if (!reachable) return skip()

    installations.mockResolvedValue([
      { account: { login: "someone-else", type: "User" }, id: 1, repository_selection: "all" },
      {
        account: { login: LOGIN, type: "Organization" },
        id: INSTALLATION_ID,
        permissions: { contents: "write" },
        repository_selection: "selected",
        suspended_at: null,
      },
    ])

    await discover({ login: LOGIN, organizationId })

    expect(await stored()).toMatchObject({
      accountLogin: LOGIN,
      organizationId,
      repositorySelection: "selected",
    })
  })

  /*
    `repository.owner_login` keeps whatever case the caller typed and GitHub answers with its own.
    A case-sensitive match would report the App as not installed while it is plainly installed —
    the same invisibility this job exists to end, with a different cause.
  */
  it("matches the login case-insensitively", async ({ skip }) => {
    if (!reachable) return skip()

    installations.mockResolvedValue([
      {
        account: { login: LOGIN.toUpperCase(), type: "Organization" },
        id: INSTALLATION_ID,
        repository_selection: "all",
      },
    ])

    await discover({ login: LOGIN.toLowerCase(), organizationId })

    expect(await stored()).toMatchObject({ organizationId, repositorySelection: "all" })
  })

  /*
    The payload names the organization, so the payload cannot be believed. Attaching an installation
    to the wrong organization hands one customer a token for another customer's repositories, which
    is exactly why `installationSync` refuses to guess.
  */
  it("refuses to link a login the named organization does not own", async ({ skip }) => {
    if (!reachable) return skip()

    installations.mockResolvedValue([
      { account: { login: "not-ours" }, id: 998_102, repository_selection: "all" },
    ])
    installations.mockClear()

    await discover({ login: "not-ours", organizationId })

    const row = await db
      .selectFrom("githubInstallation")
      .select("id")
      .where("installationId", "=", "998102")
      .executeTakeFirst()

    expect(row).toBeUndefined()
    expect(installations).not.toHaveBeenCalled()
  })

  it("does nothing when the App is not installed on that account", async ({ skip }) => {
    if (!reachable) return skip()

    installations.mockResolvedValue([{ account: { login: "elsewhere" }, id: 998_103 }])
    await expect(discover({ login: LOGIN, organizationId })).resolves.toBeUndefined()
  })
})
