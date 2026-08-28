# Successful authentication exhausted the credential pool

**Found:** 2026-08-28, by authenticating two disposable production Valkey tenants for the Celery
acceptance.

Both credentials were active, but the public proxy answered `the service is temporarily
unavailable; retry shortly`. The router host recorded the actual cause:

```text
credential lookup failed; refusing the connection: timed out waiting for a connection
```

`CredentialStore::authenticate` checked one connection out of its control-plane Postgres pool,
verified the secret, and then called `stamp_used`. That function tried to check out a second
connection while the first was still owned by its caller. Each successful authentication therefore
pinned one slot; after the finite pool filled, all later authentications timed out waiting for the
permanently occupied connections. Wrong credentials did not trigger the deadlock, which made the
failure look intermittent rather than deterministic.

The successful-authentication path now records `last_used_at` through the connection that performed
the lookup. Public `mark_used` still acquires its own connection because it is called without a
lookup in progress. A real-Postgres regression test constructs a pool of exactly one, authenticates
a live tenant under a two-second bound, and asserts both the authentication and the stamp. A larger
test pool cannot hide this defect again.
