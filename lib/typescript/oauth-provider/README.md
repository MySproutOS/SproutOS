# @lib/oauth-provider

SproutOS as an OAuth 2.1 authorization server. TASK 6.

## Scopes are the RBAC action catalogue

Not a second vocabulary. A token's effective permission is the **intersection** of what the user
can do and what they granted the client:

```
what the user can do  ∩  what they granted the client
```

Either alone is wrong. **Scopes only** lets a client keep `org:delete` after the user is demoted to
member — a grant made in March quietly outliving the permission it was based on. **RBAC only**
makes scopes decorative, so a read-only integration could delete a project.

A parallel scope vocabulary would also be two lists that drift, and one of them being wrong.

## Two bugs the tests found, both the same shape

Throwing inside `db.transaction()` **rolls back the security-relevant write**.

**The authorization code was not being burned on a failed PKCE check.** Consume-then-validate
inside one transaction means a thrown `invalid_grant` rolls the consumption back and the code
stays alive — so an attacker holding a stolen code could grind at `code_verifier` until something
worked, which is the exact attack PKCE exists to stop. The code is now consumed in its own
committed statement, _before_ anything is validated.

**The refresh family was not being revoked on reuse.** `revokeFamily` followed by `throw` in one
transaction undoes the revocation, leaving the stolen token working and the theft undetected.
Reuse is now _returned_ from the transaction, revoked in a second one, and raised after that.

Both are pinned by tests. Reintroducing either turns one red.

## Everything opaque, everything hashed

Access and refresh tokens are opaque strings stored as SHA-256 hashes — the schema says so,
`oauth_access_token.token_hash` being the primary key.

A JWT cannot be revoked before it expires without a revocation list, which is a database lookup
wearing a hat. If every check hits the database anyway, the self-contained token buys nothing and
costs the ability to revoke. Only the hash is stored, exactly as sessions do it, so a database leak
yields nothing replayable.

## The rules, and why each one

| rule                                           | what goes wrong without it                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PKCE mandatory, S256 only**                  | `plain` is a challenge equal to the verifier — anyone who saw it in a query string can produce it. The database refuses to store any other method.                                                                    |
| **Verifier 43–128 chars**                      | RFC 7636's floor exists so the verifier cannot be brute-forced from the challenge. It is a security property, not input tidiness.                                                                                     |
| **Redirect URIs matched exactly**              | Every relaxation is an open redirect: prefix matching accepts `/cb/../../evil`, subdomain wildcards fall to one compromised subdomain, ignoring the query lets `?next=` ride along.                                   |
| **`redirect_uri` re-checked at redemption**    | A code obtained through one registered URI must not be redeemable against another.                                                                                                                                    |
| **Codes single-use, 60 seconds**               | The consumption is an `UPDATE … WHERE consumed_at IS NULL`, so two simultaneous exchanges race in Postgres and exactly one wins. Read-check-write would let both through.                                             |
| **Refresh rotation with reuse detection**      | A token presented twice is a retry or a theft and there is no way to tell, so OAuth 2.1 says assume theft and burn the family. Harsh on the honest case; the alternative is a stolen token working forever, silently. |
| **Revoking a refresh kills access tokens too** | Leaving one live gives an attacker up to an hour after detection, which is most of what they wanted.                                                                                                                  |
| **Scope may narrow, never widen**              | RFC 6749 §6. Otherwise `project:read` refreshes itself into `project:delete`.                                                                                                                                         |
| **One error for unknown/used/expired codes**   | Distinguishing them tells an attacker holding a stolen code whether it was ever real.                                                                                                                                 |
| **Revocation always returns 200**              | RFC 7009 §2.2. An error for an unknown token is an oracle for whether a token exists.                                                                                                                                 |
| **Introspection requires client auth**         | Otherwise it is an oracle for guessing tokens.                                                                                                                                                                        |
| **No `http://localhost` redirect**             | RFC 8252 §7.3 — it resolves through the host's resolver, which another local process can influence. The literal loopback address is required.                                                                         |

## Verified over HTTP

A full authorization code flow against the running API:

```
consent   → https://app.example.com/callback?code=Nw2G8aYU…&state=xyz
token     → { access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "project:read" }
replay    → invalid_grant: The authorization code is invalid or has expired
refresh   → a new pair
reuse #1  → invalid_grant: This refresh token has already been used. All tokens in the family have been revoked.
use #2    → invalid_grant: The refresh token has been revoked
```

That last pair is the property that matters: reusing the _old_ token kills the _new_ one.

Discovery advertises `response_types_supported: ["code"]` — OAuth 2.1 removes the implicit grant —
and `code_challenge_methods_supported: ["S256"]`.
