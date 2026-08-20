# @lib/oauth

A vendored OAuth 2.0 authorization-code client with PKCE, plus the providers SproutOS signs in with.

## Why it is vendored

This replaces `arctic`, and `@utils/crypto` next door replaces `@oslojs/crypto` and
`@oslojs/encoding`. Authentication is the one place where an unreviewed transitive dependency is
least acceptable, and the surface we actually need is small: send the user to the provider, trade
the code for tokens, refresh later. Token revocation, implicit flow, device flow, and
client-credentials are deliberately absent — add them when something needs them.

## The two GitHub identities

SproutOS registers **both** a GitHub OAuth App and a GitHub App, and they do different jobs
([ADR 0005](../../../docs/adr/0005-both-oauth-app-and-github-app.md)):

|                                      | OAuth App | GitHub App                                            |
| ------------------------------------ | --------- | ----------------------------------------------------- |
| Signs the user in                    | ✅        | —                                                     |
| Creates a repo on a personal account | ✅        | ❌ `POST /user/repos` is not available to GitHub Apps |
| Headless upkeep between sessions     | —         | ✅ short-lived installation tokens                    |
| Rate limit                           | per user  | 5,000/hr per installation                             |

This module owns the OAuth App half. A GitHub App alone cannot satisfy the "start a project on your
own account" requirement, which is why one app was not enough.

## Scopes

Sign-in asks for `read:user` and `user:email` — **identity only**. Requesting `repo` at the front
door would mean every visitor grants blanket access to every private repository they can see just to
look at a dashboard. Repository access is escalated later, per project, as a separate consent.

`user:email` is not optional: a GitHub account's primary address is frequently private, and
`GET /user` returns `email: null` when it is. The fallback to `/user/emails` accepts only a
**verified** address — an unverified one proves nothing about who controls it.

## PKCE

GitHub documents `code_challenge` / `code_challenge_method=S256` on the authorize endpoint and
`code_verifier` on the token endpoint, both marked strongly recommended. PKCE here is real
protection, not a parameter the provider ignores.

`state` still matters independently — it is what ties the callback to a flow this browser actually
started. Both live in 10-minute httpOnly cookies and are single-use.

## Identifiers

Key accounts on the provider's **stable numeric id**, never the login or the email:

- GitHub: `id`. A login can be renamed and then claimed by someone else.
- Google: `sub`. Email addresses change hands.

Email is for contacting a user, not identifying them.

## A GitHub deviation worth knowing about

GitHub delimits the `scope` field of a token response with **commas**, where RFC 6749 §3.3 uses
spaces. `parseTokenResponse` splits on either. A space-only split silently produced a single bogus
scope like `"repo,read:user"`, which would make step-up re-authentication believe it had been
granted nothing it recognised — and then ask again, forever.

A scope token may technically contain a comma under the RFC's grammar. None in the wild does, and
breaking GitHub to preserve that possibility is the wrong trade.

## Environment

| Variable                                               | Used by                         |
| ------------------------------------------------------ | ------------------------------- |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | `githubOAuthClient()`           |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`             | `googleOAuthClient()`           |
| `NEXT_PUBLIC_HOST_URL`                                 | both, to build the redirect URI |

Clients are built by a function rather than a module-level constant, so values are read after the
process has loaded its `.env` and a missing variable fails at the point of use with a clear message.
