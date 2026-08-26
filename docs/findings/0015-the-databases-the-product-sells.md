# 15. The databases the product sells

**Date:** 2026-08-25
**Found by:** asking production for one, three times, and reading the reply

## What it looked like

A project could be created. `POST /v1/orgs/:slug/services` with `kind: postgres` answered:

```
500 Internal Server Error
```

No body. The same for `valkey`. The same for `elasticsearch` — every datastore the product sells,
on the deployment customers use.

Nothing upstream of that said anything was wrong. The drivers exist, are tested, and pass: every one
of them runs green against the compose Postgres, the compose Valkey and the compose OpenSearch. The
routes exist and are documented in the OpenAPI schema. `tofu plan` is clean. The estate is healthy.

## What was actually true

Three different things, sharing one shape: **something the application requires, that OpenTofu
created or that exists elsewhere, and that no step carries from one to the other.**

**Postgres.** `SERVICE_POSTGRES_ADMIN_URL` is unset, so `sproutPostgresConfigFromEnv` throws before
anything is attempted. `SERVICE_POSTGRES_PROVIDER` is unset too, so the choice falls to `sprout`
rather than the `neon` the architecture intends.

**Valkey.** A platform Valkey exists in AWS and is `available`. The router already carries the
tenant split — `valkey-proxy` as a library, gated on `VALKEY_PROXY_BACKEND`, which is unset.

That reads like two halves nobody connected, and it was written up that way before the two halves
were actually compared. They do not fit. The ElastiCache has `TransitEncryptionEnabled: true` and
therefore _requires_ TLS; `valkey-proxy` opens its upstream with a plain `TcpStream::connect` and
contains no TLS at all. Setting the variable would not start a working split, it would start one
that cannot reach its backend.

Nor is that instance the right home regardless: the platform Valkey holds `route:<host>` and
`credit:<organizationId>` — the router's own control-plane state. Tenant data does not belong in it,
whatever the transport.

**OpenSearch.** Bound to `127.0.0.1` on the OVH box and unreachable from AWS.

## Why it could not be caught

The drivers are tested against local containers, which is the right place to test what they do and
tells you nothing about whether the deployment can reach anything. There is no test that can fail
here, because the thing that is missing is not code.

`write_app_secrets` compounds it: it filters what Parameter Store _returned_ by a wanted list, so a
name that is not a parameter is not an error. The instance boots, reports healthy, and answers 500
on the first request that needs the value. `bin/check-app-config.mjs` now compares the three lists
that decide what reaches an instance, and `--live` asks Parameter Store itself — which is how
`APK_SIGNER_TOKEN` and `KAFKA_BROKERS` were found absent while on every list, and
`OVH_CLICKHOUSE_PASSWORD` present and delivered to nobody.

## What now stops it

A 500 is no longer the answer. `ServiceNotConfiguredError` carries the variable, and the route
answers **503 naming it**, saying plainly that this is a platform configuration problem and not a
problem with the customer's project. Misconfigured and crashed are different conditions and only one
of them is worth retrying.

That reports the gap. It does not close it, and closing it is **not symmetric**:

- **Postgres** needs an admin URL, or Neon credentials.
- **Valkey** needs the router to reach both the control-plane database and ElastiCache. Note the
  hazard before wiring it: `CredentialStore::check()` is _deliberately fatal_ at boot, so a wrong
  value does not degrade the Valkey split — it stops the router, which is the front door. The router
  is not given `DATABASE_URL` today; `user-data.sh.tftpl` composes it only for the website.
- **OpenSearch** must not simply be published the way ClickHouse is. ClickHouse is reachable from
  AWS behind a Traefik route and an IP allowlist, and its own comment says why that is safe: **"Two
  locks, not one"** — the allowlist restricts who reaches the door, and ClickHouse's user and
  password still apply. OpenSearch runs with `DISABLE_SECURITY_PLUGIN=true` because _the proxy_ is
  meant to be its boundary. An allowlist alone would be one lock on nothing, and tenant Lambdas
  egress through the same NAT the allowlist admits — so every tenant could read every other tenant's
  index. `search-proxy` exists for this. It has to be the boundary before OpenSearch is exposed at
  all.

## A note on how this entry was written

The valkey paragraph above was wrong in its first draft, in the direction this directory exists to
warn about: it said the two halves merely needed connecting, because the ElastiCache was `available`
and the proxy was present and that looked like enough. It took reading what the proxy actually opens
— `TcpStream::connect`, no TLS — against what the instance actually demands to see that they do not
fit. Both facts were a grep away the whole time.

## The question worth asking

Not "do the database drivers work" — they do, and always did. It is **"has anything ever asked this
deployment for a database?"** Nothing had. The first time anyone did, all three answered 500, and
every check that existed was green while they did it.

Related: [[0008-the-tenant-data-plane]], [[0011-the-platform-was-free]],
[[0013-the-boundary-you-cannot-test]], [[0014-everything-was-running]].
