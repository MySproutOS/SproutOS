import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { v7 } from "uuid"
import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubTransportError,
  GitHubValidationError,
  MissingGitHubAppConfigError,
} from "./errors"

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
type MintedToken = { token: string; installationId: number; expiresAt: Date }
const tokenCache = new Map<number, MintedToken>()
const storeGet = vi.fn<
  (id: number, request: { purpose: "repository-provision" }) => Promise<MintedToken>
>(async (id, request) => {
  const hit = tokenCache.get(id)
  if (hit !== undefined) return hit
  const result = await minted(id, request)
  tokenCache.set(id, result)
  return result
})
const cleared = vi.fn<(installationId?: number) => void>((installationId) => {
  if (installationId === undefined) tokenCache.clear()
  else tokenCache.delete(installationId)
})
const signed = vi.fn<() => string>(() => "signed.app.jwt")

vi.mock("./app-auth", () => ({
  createInstallationTokenStore: () => ({ get: storeGet, clear: cleared }),
  envAppJwtSigner: () => signed,
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

beforeEach(() => {
  tokenCache.clear()
  minted.mockClear()
  storeGet.mockClear()
  cleared.mockClear()
  signed.mockReset()
  signed.mockReturnValue("signed.app.jwt")
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

  it("tries the next installation when a stale App row cannot mint", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockImplementationOnce((_id, _request) =>
      Promise.reject(
        new GitHubValidationError(
          422,
          "/app/installations/stale/access_tokens",
          "The repository is not accessible to the parent installation",
        ),
      ),
    )

    const credential = await organizationGitHubCredential(db, organizationId, PROVISION)

    expect(credential).toMatchObject({ kind: "installation" })
    expect(minted).toHaveBeenCalledTimes(2)
  })

  it("recognizes GitHub's alternate selected-repository refusal", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockImplementationOnce((_id, _request) =>
      Promise.reject(
        new GitHubValidationError(
          422,
          "/app/installations/stale/access_tokens",
          "The repository does not exist or is inaccessible to the parent installation.",
        ),
      ),
    )

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).resolves.toMatchObject({ kind: "installation" })
    expect(minted).toHaveBeenCalledTimes(2)
  })

  it("tries the next installation when the old App no longer owns a row", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockRejectedValueOnce(
      new GitHubNotFoundError(404, "/app/installations/stale/access_tokens", "Not Found"),
    )

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).resolves.toMatchObject({ kind: "installation" })
    expect(minted).toHaveBeenCalledTimes(2)
  })

  it("does not mask an App-wide authentication failure", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockRejectedValueOnce(
      new GitHubAuthError(401, "/app/installations/stale/access_tokens", "Bad credentials"),
    )

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).rejects.toBeInstanceOf(GitHubAuthError)
    expect(minted).toHaveBeenCalledTimes(1)
  })

  it("does not mask an unrelated validation failure", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockRejectedValueOnce(
      new GitHubValidationError(
        422,
        "/app/installations/stale/access_tokens",
        "Permissions are not granted to this installation",
      ),
    )

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).rejects.toBeInstanceOf(GitHubValidationError)
    expect(minted).toHaveBeenCalledTimes(1)
  })

  it("still tries a row whose cached suspension is stale", async ({ skip }) => {
    if (!reachable) return skip()

    // Prime the process cache while the database still says active.
    await organizationGitHubCredential(db, organizationId, PROVISION, "Andrew-Chen-Wang")
    expect(minted).toHaveBeenCalledTimes(1)

    await db
      .updateTable("githubInstallation")
      .set({ suspendedAt: new Date() })
      .where("installationId", "=", String(PERSONAL))
      .execute()

    const credential = await organizationGitHubCredential(
      db,
      organizationId,
      PROVISION,
      "Andrew-Chen-Wang",
    )

    expect(credential).toMatchObject({ token: `ghs_${PERSONAL}` })
    expect(minted).toHaveBeenCalledTimes(2)
    expect(cleared).toHaveBeenCalledWith(PERSONAL)
    expect(cleared.mock.invocationCallOrder[0]).toBeLessThan(minted.mock.invocationCallOrder[1])

    await db
      .updateTable("githubInstallation")
      .set({ suspendedAt: null })
      .where("installationId", "=", String(PERSONAL))
      .execute()
  })

  it("does not hide a provider outage by trying another installation", async ({ skip }) => {
    if (!reachable) return skip()

    minted.mockRejectedValueOnce(
      new GitHubTransportError("/app/installations/970002/access_tokens"),
    )

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).rejects.toBeInstanceOf(GitHubTransportError)
    expect(minted).toHaveBeenCalledTimes(1)
  })

  it("falls back when the lazy App signer has no configuration", async ({ skip }) => {
    if (!reachable) return skip()

    signed.mockImplementationOnce(() => {
      throw new MissingGitHubAppConfigError("GITHUB_APP_PRIVATE_KEY")
    })

    await expect(
      organizationGitHubCredential(db, organizationId, PROVISION),
    ).resolves.toBeUndefined()
    expect(minted).not.toHaveBeenCalled()
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
})
