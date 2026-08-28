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

Installation-token resolution now tries every matching row in deterministic order. Only a missing
installation or GitHub's two exact selected-repository refusals skip a candidate. Authentication,
unrelated validation, transport, and rate-limit errors remain App-wide failures and escape instead
of being disguised as a credential miss. A cached-suspended row is also tried because GitHub is
authoritative, but its process-cached token is evicted first: a real suspension is refused by a new
mint, while a stale suspension can recover without waiting for a webhook that may never arrive.

The lazy environment signer is invoked once before building the store. Catching only its factory
could never observe missing App configuration because the factory returns a closure and the closure
does the actual read.

The database tests cover both rollover failures and assert that a provider outage does not trigger
credential roulette.

Discovery jobs are now idempotent per project operation and GitHub App id as well as organization
and login. A retry of one create deduplicates, while a later project created after an App rollover,
a later installation, or a missed webhook performs a new authoritative discovery instead of
joining an obsolete terminal job.
