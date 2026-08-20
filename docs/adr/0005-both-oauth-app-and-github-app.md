# 0005. Register both a GitHub OAuth App and a GitHub App

- Status: Accepted
- Date: 2026-08-20

## Context

This is the deepest conflict in the research, because both sides argued from documentation and one
of them is simply wrong about what the platform allows.

The auth notes, Decision 1: "**Register BOTH a GitHub App and use it for identity too — one app, two
token families.** … a second OAuth App would only add a coarse all-or-nothing `repo` scope we never
want." GitHub Apps do issue user-to-server tokens through the same `/login/oauth/authorize` web flow,
so identity from a GitHub App alone is genuinely possible.

The projects notes, Decision 1: "**Two GitHub identities, not one.** A GitHub **OAuth App** for login

- repo creation/fork/delete, plus a **GitHub App** installation for headless work" — justified by
  `POST /user/repos` being `enabledForGitHubApps: false` in GitHub's own OpenAPI description.

That last fact is decisive. Under the auth area's one-app design, SproutOS literally cannot create a
repository on a user's personal account, which means TASK 8 fails. The projects area is right, and
the auth area's reasoning about scope coarseness is a real cost we accept rather than a refutation.

## Decision

Register both.

- **OAuth App** — identity (`read:user`, `user:email`) and _user-initiated_ repo operations:
  create, fork, delete. Scope escalation to `repo` (and `delete_repo` only if the user opts into
  repo deletion) happens at first project creation, which is exactly TASK 9's "reauthenticate to
  view more settings".
- **GitHub App** — headless upkeep. Installation tokens (`ghs_`, 1 hour) for the fork-upkeep agent,
  PR creation, and metadata sync. 5,000 req/hr _per installation_, scaling above 20 repos, so heavy
  tenants do not consume one shared user budget.

## Consequences

- Two registrations, two consent screens, two sets of environment variables. The names are frozen
  here to stop the three-way drift in the notes: `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`
  for the OAuth App; `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_CLIENT_ID` /
  `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_WEBHOOK_SECRET` for the App.
- The `account` table stores OAuth App tokens, envelope-encrypted. Installation tokens are minted
  on demand and never persisted.
- Repo _writes_ prefer the installation token; only the operations GitHub Apps cannot perform fall
  back to the user token. The agent runner gets neither — see the no-push-credential rule in the
  agent phase.
- The user token is a shared 5,000 req/hr budget across everything we do as that user. Reserve it
  for identity and `/user/installations`.
- **GitHub does not support PKCE.** The auth notes claim it does; the critique flags this as false.
  Treat `state` as the only CSRF defence: session-bound, single-use, 10-minute expiry. The vendored
  `OAuth2Client` will send a `code_verifier` GitHub discards — harmless, but not protection.

## Alternatives considered

**GitHub App only** (the auth area's design). Rejected: cannot create personal repos, so TASK 8 fails.

**OAuth App only.** Rejected: the `repo` scope is all-or-nothing across every repo the user can reach,
rate limits are per-user rather than per-installation, and headless upkeep would run on a token that
decays when the user rotates credentials.
