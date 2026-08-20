# `@lib/github`

The GitHub REST surface project provisioning needs — repository creation, forks, template
generation, and the installation-token exchange — with the credential split from
[ADR 0005](../../../docs/adr/0005-both-oauth-app-and-github-app.md) encoded in the types.

This package knows nothing about the database. It takes a credential and a client, and returns
plain objects. `repository` rows are written by `@lib/dao`, not here.

## Two token families, and one endpoint that only accepts one of them

SproutOS registers both a GitHub OAuth App and a GitHub App. The reason is a single line in
GitHub's own OpenAPI description: `POST /user/repos` is `enabledForGitHubApps: false`. An
installation token cannot create a repository on a personal account, and the failure it gives is a
403 whose message reads like a missing permission — which sends the reader looking at the app's
permission list, where nothing is wrong.

So the credential is a discriminated union and `createPersonalRepository` accepts only
`GitHubUserToken`:

```ts
import { createPersonalRepository, forkRepository, userToken } from "@lib/github"

await createPersonalRepository(client, userToken(oauthToken), { name: "linkding" })
await forkRepository(client, installation, { owner: "sissbruecker", repo: "linkding" })
```

Passing an installation token to the first is a type error. There is a runtime check behind it as
well, for the credential that lost its type crossing a JSON boundary; it throws
`GitHubCredentialError` **before** the request goes out, so the diagnosis costs nothing and names
the ADR.

Everything else — org repositories, forks, template generation — prefers the installation token,
because its 5,000 req/hr budget is per installation. The user token is one shared budget across
everything the platform ever does as that user.

The user's OAuth token lives in `account.access_token_ciphertext`, envelope-encrypted. Read it
with `@lib/envelope` at the point of use; do not pass it further than the one call that needs it.

## The client is injected

```ts
export interface GitHubClient {
  request<T>(request: GitHubRequest): Promise<GitHubResponse<T>>
}
```

`createGitHubClient()` is the only thing in the package that performs I/O, and every operation
takes a `GitHubClient` as its first argument. Tests pass a fake. This is not a testing
convenience — exercising fork creation against the real API would leave repositories behind on
somebody's account, and a checkout does not have the credentials to do it anyway.

## Installation tokens

`createInstallationTokenStore` mints `ghs_` tokens and caches them per installation until five
minutes before expiry. Tokens last an hour; the skew exists because a token that dies halfway
through a fork leaves a half-created repository, which costs far more than an early refresh. The
cache is in-process only and deliberately so — an installation token in a shared cache is a
credential at rest with no envelope around it, and re-minting after a deploy is one request.

It takes a `signJwt: () => string` rather than the key itself, which is what lets the whole
exchange be tested without one:

```ts
const store = createInstallationTokenStore({ client, signJwt: envAppJwtSigner() })
const credential = await store.get(installation.installationId)
```

**`GITHUB_APP_PRIVATE_KEY` is empty in a fresh checkout.** `githubAppConfigFromEnv()` therefore
throws `MissingGitHubAppConfigError` naming the variable, rather than letting an empty string
reach `createSign` and surface as `error:1E08010C:DECODER routines::unsupported`. Callers with a
user token to fall back on catch it and do so. `createAppJwt` is tested against a key the test
generates itself, so no suite needs the real one.

A PEM flattened into a single `.env` line is un-escaped on read, because a PEM does not otherwise
survive one.

## Failures are typed

Nothing raw escapes. A `fetch` rejection is a `TypeError` whose message varies by runtime, and
GitHub overloads 403 for both "your token cannot do this" and "you are out of quota" — a caller
deciding between _retry later_ and _this will never work_ cannot do it against either.

| Error                         | Means                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `GitHubTransportError`        | Never reached GitHub. Always retryable                       |
| `GitHubRateLimitError`        | Primary or secondary limit, with `retryAfterSeconds`         |
| `GitHubAuthError`             | 401, or a 403 that is about the credential                   |
| `GitHubNotFoundError`         | 404 — also what a private repo looks like to the wrong token |
| `GitHubValidationError`       | 422 — the name is taken, the branch does not exist           |
| `GitHubCredentialError`       | Wrong credential kind for the endpoint                       |
| `MissingGitHubAppConfigError` | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` absent            |

`retryAfterSeconds` is `retry-after` when GitHub sent one, otherwise the distance to
`x-ratelimit-reset`, and it is clamped at zero so clock skew cannot turn a backoff into a hot
loop. `x-ratelimit-*` is parsed off successful responses too — `response.rateLimit` — so a batch
job can slow down before it hits the wall rather than after.

## What needs real credentials

Everything in `src/repositories.ts` is unit-tested against the fake and has never been run against
GitHub in CI. Exercising it for real needs:

- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` and a user who has completed the
  `repo`-scope step-up, for personal repository creation.
- A GitHub App installation and a populated `GITHUB_APP_PRIVATE_KEY`, for installation tokens,
  `/installation/repositories`, and headless forks.

Neither is present in development. The provisioning routes reflect that: they enqueue a
`project_job` and return, so the request path never depends on a credential that may not exist.
