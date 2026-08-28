import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { v7 } from "uuid"

/*
  Provisioning resolved only the signed-in user's OAuth token and, finding no `repo` scope, raised
  `NoUsableCredentialError` — an error whose message tells the customer to install the App. The App
  was installed. Nothing in that path could consult an installation, so the next attempt failed
  identically. `docs/findings/0006` is that shape: a remedy named by an error and implemented
  nowhere.

  The minting exchange is faked; what is asserted here is which installation gets chosen, which is
  the part that is easy to get quietly wrong.
*/
const minted =
  vi.fn<
    (
      id: number,
      request: { purpose: "repository-provision" },
    ) => Promise<{ token: string; installationId: number; expiresAt: Date }>
  >()

vi.mock("./app-auth", () => ({
  createInstallationTokenStore: () => ({ get: minted, clear: () => {} }),
  envAppJwtSigner: () => () => "signed.app.jwt",
}))

const { organizationGitHubCredential } = await import("./installation-credential")

let reachable = false
let organizationId: string
let ownerUserId: string

const PERSONAL = 970_001
const ORGANIZATION = 970_002
const PROVISION = { purpose: "repository-provision" } as const

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  minted.mockImplementation((id, _request) =>
    Promise.resolve({
      token: `ghs_${id}`,
      installationId: id,
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  )

  ownerUserId = v7()
  organizationId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `inst-${ownerUserId}@test.invalid`, name: "Inst" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Installation Org",
      slug: `inst-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()

  // Two installations on one organization: a personal account and a GitHub organization. This is
  // ordinary, and it is what makes "whichever sorted first" a wrong answer.
  for (const [installationId, login, type] of [
    [PERSONAL, "Andrew-Chen-Wang", "User"],
    [ORGANIZATION, "TestSproutOS", "Organization"],
  ] as const) {
    await db
      .insertInto("githubInstallation")
      .values({
        id: v7(),
        organizationId,
        installationId: String(installationId),
        accountLogin: login,
        accountType: type,
        repositorySelection: "all",
        permissions: {} as never,
      })
      .execute()
  }
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("githubInstallation").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

describe("organizationGitHubCredential", () => {
  /*
    GitHub answers a token minted for the wrong account with a 404 on repository creation — not
    "wrong credential" but "no such place", which sends the reader hunting for a typo in a name
    that is correct.
  */
  it("mints for the account the repository will live on", async ({ skip }) => {
    if (!reachable) return skip()

    const credential = await organizationGitHubCredential(
      db,
      organizationId,
      PROVISION,
      "TestSproutOS",
    )

    expect(credential).toMatchObject({ kind: "installation", token: `ghs_${ORGANIZATION}` })
  })

  it("matches the account login case-insensitively", async ({ skip }) => {
    if (!reachable) return skip()

    const credential = await organizationGitHubCredential(
      db,
      organizationId,
      PROVISION,
      "testsproutos",
    )

    expect(credential).toMatchObject({ token: `ghs_${ORGANIZATION}` })
  })

  it("falls back to the organization's newest installation when no account is named", async ({
    skip,
  }) => {
    if (!reachable) return skip()

    expect(await organizationGitHubCredential(db, organizationId, PROVISION)).toMatchObject({
      kind: "installation",
    })
  })

  /*
    Undefined, not a throw. The caller still has the user's own token to fall back to, and it is the
    caller that knows whether running out of options is fatal.
  */
  it("returns undefined when the account has no installation", async ({ skip }) => {
    if (!reachable) return skip()

    expect(
      await organizationGitHubCredential(db, organizationId, PROVISION, "somebody-else"),
    ).toBeUndefined()
  })

  it("returns undefined for an organization with none at all", async ({ skip }) => {
    if (!reachable) return skip()

    expect(await organizationGitHubCredential(db, v7(), PROVISION)).toBeUndefined()
  })

  /*
    A suspended installation still has a row and still mints nothing. Excluded here so the caller
    falls back, rather than discovering it as a 403 from GitHub several frames down.
  */
  it("ignores a suspended installation", async ({ skip }) => {
    if (!reachable) return skip()

    await db
      .updateTable("githubInstallation")
      .set({ suspendedAt: new Date() })
      .where("installationId", "=", String(PERSONAL))
      .execute()

    expect(
      await organizationGitHubCredential(db, organizationId, PROVISION, "Andrew-Chen-Wang"),
    ).toBeUndefined()

    await db
      .updateTable("githubInstallation")
      .set({ suspendedAt: null })
      .where("installationId", "=", String(PERSONAL))
      .execute()
  })
})
