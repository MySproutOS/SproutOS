import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import {
  createInstallationTokenStore,
  envAppJwtSigner,
  type InstallationTokenRequest,
} from "./app-auth"
import { createGitHubClient } from "./client"
import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubValidationError,
  MissingGitHubAppConfigError,
} from "./errors"
import { installationToken } from "./types"
import type { GitHubCredential } from "./types"

/**
 * The App's own credential for an organization, which is the one the platform is supposed to prefer.
 *
 * ADR 0005 and [[userGitHubCredential]]'s own docstring both say an installation token is "the right
 * credential ... and the one every path here reaches for first". Provisioning did not reach for it
 * at all: it resolved the signed-in user's OAuth token and, finding no `repo` scope, raised
 * `NoUsableCredentialError` — whose message names the installation as the fix. So the error told
 * customers to install the App, the App was installed, and the next attempt failed identically,
 * because nothing in that path could ever consult an installation.
 *
 * That shape — an error promising a remedy no code implements — is `docs/findings/0006`.
 *
 * `undefined` rather than a throw when no candidate can mint: no installation, no App key, a
 * genuinely suspended installation, or rows belonging to an old App. The caller still has the
 * user token to fall back to, and it is the caller that knows whether running out of options is
 * fatal.
 */
export async function organizationGitHubCredential(
  db: Kysely<DB>,
  organizationId: string,
  request: InstallationTokenRequest,
  accountLogin?: string,
): Promise<GitHubCredential | undefined> {
  let query = db
    .selectFrom("githubInstallation")
    .select(["installationId", "accountLogin"])
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)

  /*
    Prefer the installation on the account the repository will actually live on.

    An organization can have several installations — a personal account and one or more GitHub
    organizations. Taking whichever sorted first would mint a token for the wrong account, and
    GitHub answers that with a 404 on repository creation: not "wrong credential", but "no such
    place", which sends the reader hunting for a typo in a name that is correct.
  */
  if (accountLogin !== undefined) {
    query = query.where((eb) => eb.fn("lower", ["accountLogin"]), "=", accountLogin.toLowerCase())
  }

  /*
    All candidates, including a row whose last webhook said it was suspended.

    The row is a cache of GitHub state, not the authority. During an App rollover an old App's
    installation and the replacement App's installation can both be present, and a missed
    `unsuspend` delivery can leave the usable one marked suspended forever. Choosing one row made
    either condition fatal: GitHub's 401/404/422 escaped as an API 500 and no later installation or
    user credential was ever tried.

    Minting is the authoritative, narrowly scoped check. A genuinely suspended installation is
    refused by GitHub and skipped below; a stale suspension succeeds and becomes usable again
    without trusting the cache over the provider.
  */
  const installations = await query.orderBy("id", "desc").execute()
  if (installations.length === 0) return undefined

  let signJwt: () => string
  try {
    signJwt = envAppJwtSigner()
  } catch (error) {
    // A deployment without the App key configured. Not fatal: the user's own token still works.
    if (error instanceof MissingGitHubAppConfigError) return undefined
    throw error
  }

  store ??= createInstallationTokenStore({ client: createGitHubClient(), signJwt })
  for (const installation of installations) {
    try {
      // Deliberately sequential: the first usable credential wins, and parallel mints would issue
      // live tokens for every stale candidate before we know whether the first one was sufficient.
      // eslint-disable-next-line no-await-in-loop
      const minted = await store.get(Number(installation.installationId), request)
      return installationToken(minted.token, minted.installationId, minted.expiresAt)
    } catch (error) {
      /*
        These are permanent for this candidate, not for the operation.

        - auth/not-found: the row belongs to an old App, or the installation was removed;
        - validation: an exact repository is outside this installation's selected repositories, or
          the installation does not grant the requested permission.

        Transport and rate-limit failures still escape. Trying another credential when GitHub is
        down or has told us to wait would hide the outage and spend a second rate-limit budget.
      */
      if (
        error instanceof GitHubAuthError ||
        error instanceof GitHubNotFoundError ||
        error instanceof GitHubValidationError
      ) {
        continue
      }
      throw error
    }
  }

  return undefined
}

/**
 * Built lazily and kept for the process, matching `agent-chat.ts`.
 *
 * `envAppJwtSigner()` reads the private key, and dotenv has not necessarily run when this module is
 * first evaluated — constructing at import time turns a missing key into a startup crash for every
 * caller rather than an absent credential for the one request that needed it.
 */
let store: ReturnType<typeof createInstallationTokenStore> | null = null
