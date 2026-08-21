# 0025 — Self-hosted Neon, and the control plane it requires

**Status:** accepted. Storage and compute both running and verified locally.

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
