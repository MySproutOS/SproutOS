# 0073 — A stale GitHub installation blocked every credential

Found by authorizing a real third-party OAuth client and asking it to create a production project.

The organization had installation rows from two GitHub Apps during the production-App rollover.
The API selected one row, asked the current App to mint a token for it, and GitHub correctly
answered 422: that installation did not belong to the current App and could not see the requested
repository. The exception escaped as HTTP 500. No other installation and no user OAuth credential
was tried.

A second attempt created the project row, but the worker found the replacement installation marked
suspended from an old webhook. GitHub reported the installation active; the cached row kept the
worker from trying it, and the job exhausted its retries with `NoUsableCredentialError`.

## Guard

Installation-token resolution now tries every matching row in deterministic order. A candidate
that GitHub rejects as unauthenticated, missing, or invalid is skipped; transport and rate-limit
errors still escape rather than being disguised as a credential miss. Minting is also allowed for
a cached-suspended row, because GitHub is authoritative: a real suspension is refused there, while
a stale suspension can recover without waiting for a webhook that may never be redelivered.

The database tests cover both rollover failures and assert that a provider outage does not trigger
credential roulette.
