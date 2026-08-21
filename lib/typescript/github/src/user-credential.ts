import { open } from "@lib/envelope"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import type { GitHubCredential } from "./types"

/**
 * A user's own GitHub token, when it can do repository work.
 *
 * The platform has two GitHub identities (ADR 0005) and prefers the App: an installation token is
 * scoped to the repositories the customer granted, carries its own rate-limit budget, and works
 * without anybody being signed in. That is the right credential for headless upkeep and the one
 * every path here reaches for first.
 *
 * It is not always available. The App needs a private key the deployment may not have, and an
 * organization may simply not have installed it — and in both cases the person asking for the work
 * is signed in, with a token GitHub issued them, for repositories that are theirs. Refusing then is
 * refusing on a technicality: `fetchUser`-shaped fallbacks like this one are what let a customer
 * fork an app and talk to the agent before an App installation exists.
 *
 * `undefined`, not a throw, when the scope is missing. The caller decides whether that is fatal,
 * and every caller has a better message than this module could write.
 */
export const REPOSITORY_SCOPE = "repo"

export async function userGitHubCredential(
  db: Kysely<DB>,
  userId: string,
): Promise<GitHubCredential | undefined> {
  const account = await db
    .selectFrom("account")
    .select(["accessTokenCiphertext", "accessTokenWrappedDek", "accessTokenKmsKeyId", "scopes"])
    .where("userId", "=", userId)
    .where("provider", "=", "github")
    .executeTakeFirst()

  if (account?.accessTokenCiphertext == null) return undefined
  if (account.accessTokenWrappedDek == null || account.accessTokenKmsKeyId == null) return undefined

  /*
    The scope is checked here rather than left to GitHub.

    A token without `repo` does not get a 403 on a private repository — it gets a 404, because
    GitHub does not reveal the existence of repositories you cannot see. That is the correct
    behaviour and a terrible error: it sends the reader looking for a typo in a name that is right.
  */
  if (!account.scopes.includes(REPOSITORY_SCOPE)) return undefined

  const token = await open(
    {
      ciphertext: account.accessTokenCiphertext,
      wrappedDek: account.accessTokenWrappedDek,
      kmsKeyId: account.accessTokenKmsKeyId,
    },
    { userId, provider: "github", field: "access_token" },
  )

  return { kind: "user", token }
}
