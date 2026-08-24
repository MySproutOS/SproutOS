# 0025 — Postgres on Neon

**Status:** **superseded in part.** Self-hosting was built, verified end to end, and then reversed
in favour of Neon's Agent plan — see the addendum at the bottom, which is the operative decision.
Everything before it is the record of what was built and why, kept because the evidence it produced
is what made the reversal possible.

## Context

Three backlog items were `[~]` for one reason. `database_instance.provider` allows
`neon | byo | sprout`, and what the platform provisioned was `sprout`: a database and a role on an
ordinary Postgres cluster, reached through `pg-proxy`. That is a real product. It is not Neon, and
the two things the backlog actually asked for — branching a database to test against, and sub-second
cold starts — are properties of Neon's _storage layer_, not of a Postgres with a good proxy in front.

The decision taken with the user early on was **self-hosted Neon open source, with our own control
plane. Not the Neon SaaS API.** That decision was recorded and then not acted on for a long time,
because it is the largest single piece of infrastructure in the product.

## Decision

Run the OSS components: `storage_broker`, `safekeeper`, `pageserver`, `storage_controller`. The
pageserver's remote storage is S3 — LocalStack in development, the platform's own bucket in
production. Separating compute from storage is the entire design; a pageserver with only a local
disk is Neon with the interesting part removed.

`lib/typescript/services/src/neon.ts` is the client, and it talks **only** to the storage controller.
Never to a pageserver directly: which pageserver holds a tenant is the controller's answer to give,
and it changes under shard splits and migrations.

## The thing that was not obvious

**A control plane is not something you add on top of Neon's storage layer. It is a component the
storage layer requires.**

The storage controller notifies the control plane every time it attaches a tenant. With no
`--control-plane-url` it does not degrade — it panics:

```
notify_attach{...}:panic{location=storage_controller/src/compute_hook.rs:892:56}:
called `Option::unwrap()` on a `None` value
```

and it panics _after_ creating and attaching the tenant, so what is left behind is a tenant that
exists, a reconcile that never completes, and a `POST /v1/tenant` that returns nothing at all. Point
it at a URL that answers anything other than 200 and it retries the same reconcile forever.

So `/v1/internal/neon/notify-attach` had to exist before any of this worked at all, and
`neon_shard_placement` is the state it keeps. That is not bookkeeping: pointing a compute at the
pageserver currently holding its pages is the only thing that makes the compute work, and only the
controller knows which one that is.

The request shape was read off the controller's own log — it prints the struct it is about to send —
rather than guessed from its source:

```
PUT {control_plane_url}/notify-attach
{ "tenant_id": "<32 hex>", "preferred_az": "local", "stripe_size": null,
  "shards": [ { "node_id": 1, "shard_number": 0 } ] }
```

## What is verified

A tenant created, a timeline created, and a second timeline branched from it with
`ancestor_lsn 0/14EE2C0` and `current_physical_size 0`. **The branch copied nothing.** That is the
property `database_branch` was designed around and could not deliver, and `neon.test.ts` asserts it
against the running stack rather than against a description of it.

## What is not built

**Compute.** A Postgres process started against these pages by `compute_ctl`, and the `proxy` that
wakes one on connect. Until that exists there is storage without a database anyone can connect to,
and the driver in `neon.ts` is deliberately _not_ a `ServiceDriver` for that reason — a `provision`
that reported success and handed back a URI nothing answers on would be worse than the gap.

Sub-second cold starts are a property of that piece, so they remain unclaimed. What this ADR settles
is that the layer underneath them is real and running.

## Three things every circulating example gets wrong

They predate the storage controller, and each fails in a way that does not name its cause:

- `pageserver -c key=value` is rejected outright: `error: unexpected argument '-c' found`, which is
  the entire message. It reads a TOML from its workdir now.
- That TOML must set `control_plane_api`, which means a `storage_controller` must exist to point it
  at — so the minimum useful stack is four processes, not three.
- `control_plane_api` must appear **above** `[remote_storage]`. A bare key after a table header
  belongs to that table in TOML, so appending it to the file produces
  `remote_storage.control_plane_api` and the identical `must be set` error with the key plainly
  visible in the file.

## And the one that cost the most

The safekeeper advertises its **listen** address to the broker unless given `--advertise-pg`. Bind it
to `0.0.0.0:5454` — which every example does, because it must accept connections from other
containers — and the pageserver reads `0.0.0.0:5454` out of the broker and connects to itself.

Nothing says so. The safekeeper is healthy and says nothing. The pageserver logs one
`Connection refused` per retry, buried in normal reconnection chatter. The symptom appears three
components away, as a compute hanging forever on a page request:

```
[NEON_SMGR] no response received from pageserver for 140.098 s, still waiting
handle_get_page_at_lsn_request_batched: slow wait_lsn still running for 151.003s
```

— because the WAL never reaches the pageserver, so the LSN the compute is waiting for never arrives.
Every layer reports the layer below it as slow, and the actual fault is a listen address being used
as a connect address two hops away.

## Addendum, 2026-08-24 — superseded: we use Neon's Agent plan

**Status of everything above: retained as a record, not as a plan.**

The research pass found what the original decision did not consider: `neondatabase/neon` has taken
eleven commits in twelve months since the Databricks acquisition, last commit 2026-05-25. Neon also
sells an **Agent plan** aimed precisely at platforms provisioning Postgres for end users —
$0.106/CU-hour, unlimited projects, and the free tier sponsored rather than funded by us.

The first answer was to fork and keep self-hosting. Within the hour that was reversed to **use the
Agent plan**, and the reversal is right. The argument for self-hosting was that the code works, and
it does — this repository proved copy-on-write branching and a 214ms wake-on-connect against it in a
day. The argument against is that owning it means owning it: from the moment we fork a stale tree, a
CVE in the pageserver is ours to notice and ours to fix, forever, for a platform with no customers
yet. Paying Neon to run the thing Neon built is the cheaper answer to a problem we do not want.

`MySproutOS/neon` still exists. It costs nothing and is a hedge; it is not on the path.

### What this retires

- The self-hosted storage layer in `docker-compose.yaml` — `storage_broker`, `safekeeper`,
  `pageserver`, `storage_controller`.
- `dockerComputeLauncher` and `computeSpec`. Neon starts its own computes.
- `wakeEndpoint` and `neon_endpoint`'s `starting` claim. **Neon's own proxy does wake-on-connect**,
  which is the feature we reimplemented; measuring ours at 214ms was worth doing precisely because it
  showed the feature is real and cheap, and Neon gets it for free.
- `/v1/internal/neon/notify-attach` and `neon_shard_placement`. That endpoint existed because a
  self-hosted storage controller panics without a control plane to notify. There is no longer a
  storage controller of ours.
- `scramVerifier` for the compute admin role. There is no compute of ours to hold a password.

### What survives, and it is most of the value

- **`services/pg-proxy`.** The customer holds a _SproutOS_ credential, never a Neon one — the same
  boundary object storage has. The proxy authenticates them against `service_credential`, resolves
  the tenant, and connects onward with the platform's Neon credential. Nothing about that changes;
  only what sits behind it does.
- **`database_instance`, `database_branch`, `service_credential`.** `provider = 'neon'` now means a
  real Neon project id in `provider_project_id` and a real branch id in `provider_branch_id`, which
  is what those columns were named for in the first migration.
- **`neonPostgresDriver`'s shape.** Provision creates a project and a branch and starts nothing; the
  customer receives a working connection string for a database with no compute running. That was
  true against our own pageserver and it is true against Neon's.

### What is new

- A client for Neon's control-plane API — projects, branches, endpoints, roles.
- Their **Consumption API** for billing, whose metric names the metering schema was already told to
  mirror: `compute_unit_seconds`, `root_branch_bytes_month`, `child_branch_bytes_month`. That
  guidance was written for a world where we had to _imitate_ those metrics from our own pageserver.
  Now they arrive from the source, and the six arithmetic corrections in `docs/research/0001` — the
  744-hour month, decimal GB, storage metrics already divided by 744 — stop being theoretical.

### The honest accounting

A week of self-hosted Neon work is retired by this. It was not wasted: it is what produced the
research that found the eleven-commits figure and the Agent plan, and it is why the decision could be
made on evidence rather than on a vendor page. But it is retired, and pretending otherwise by keeping
the code alive "just in case" would cost more than it saved.
