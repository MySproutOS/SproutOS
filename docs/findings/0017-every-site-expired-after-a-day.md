# 0017 — Every tenant site stopped resolving 24 hours after its last deploy

## What was wrong

`publishRoute` writes the router's map entry with a lease:

```ts
await valkey.set(key(hostname), JSON.stringify(route), "EX", ROUTE_TTL_S) // 24 hours
```

It is called from exactly one place — `publishRelease`, at deploy time. Nothing else ever wrote a
`route:` key, and nothing refreshed one.

The router has no other source. `Resolver::resolve` reads the key; on a miss `serve_connection`
answers `404 no application here`. There is no read-through to Postgres, and deliberately so: the
comment above it explains that a Valkey outage must fail open to 404 rather than 502, which is
correct reasoning about a _cache_ and became load-bearing the moment the cache was the only copy.

So a project deployed on Monday served until Tuesday and then vanished. Not degraded — gone, with
the same response a hostname that never existed gets.

## How it looked while it was wrong

Like nothing at all, for a day at a time.

Every deploy worked. Every test passed. The dashboard showed `ready`. A customer who deployed and
checked their site saw it working, because they checked within minutes. The failure only ever
appeared to someone who came back the next day, and to them it looked like the platform had
forgotten their project — which is exactly what had happened.

The production database made it invisible from another angle too: every deployment in the account
had failed for an unrelated reason (`No build artifact was uploaded for this release`), so no
project had a live route to lose. The bug was fully armed and had nothing to fire at.

## Why the checks did not catch it

`publish.test.ts` deploys and asserts the route exists. That assertion is true, was always true, and
was never the question.

The shape is worth naming, because it is not a missing test — it is a test asserting the wrong half
of a two-part property. "The route is written" and "the route is _still there tomorrow_" look like
the same statement and are not, and only one of them was ever checked. The recurring lesson in this
directory applies exactly: the question worth asking of a check is not whether it passes but what
would have to be true for it to fail. Here the answer was "wait 24 hours", which no test does.

## What stops it now

Three checks now cover the failure from different directions:

1. **`platform.refresh_routes`**, hourly, republishing every live project's route from
   `project.live_deployment_id`. Hourly against a 24-hour lease means twenty-three consecutive
   failures before anyone notices.
2. **`refresh-routes.test.ts`**, which deletes the key by hand — expiry, as the router experiences
   it — and asserts the route comes back, and that its new lease is hours rather than seconds.

3. **The router reads through to Postgres on a clean Valkey miss.** It resolves only the live,
   ready production deployment belonging to the exact generated or active custom hostname, then
   restores the 24-hour Valkey entry. A Valkey error remains a 404 instead of moving the entire hot
   path onto Postgres; a Postgres error also fails closed and is not cached. The durable connection
   and its TLS configuration are checked at boot, so a deployment cannot look healthy while this
   second defence is absent.

The refresher is driven from the live-deployment pointer rather than from the deployment table, so a
release that has been rolled back past does not resurrect its own hostname, and a project whose
pointer is null stays down.

## What to be suspicious of next

Any state that is written once and read forever. `live:<project id>` and `credit:<organization id>`
carry the same kind of lease from the same module. The credit key is refreshed by the billing jobs;
`live:` is now refreshed alongside the route. Anything else acquiring a TTL should arrive with the
writer that renews it, in the same change.
