# 0026 — AWS only, Lambda for tenants, and two Rust proxies

**Status:** accepted, superseding 0012, 0022 and 0024. Not yet built.

## Context

The platform was multi-cloud by intent and Kubernetes by construction: Knative Serving for tenant
web apps, Kata or gVisor for isolation, a cgroup DaemonSet for metering, and a smoke script proving
the same manifests worked on GKE, AKS and EKS. All of that worked, and one thing it never did was
serve a tenant request cheaply. A Knative revision on a managed cluster costs a node whether or not
anyone visits, and the cluster costs a control plane whether or not it holds any tenants.

The decision taken now is to stop paying for idle capacity in every layer at once.

## Decision

**AWS only.** GCP and Azure are dropped. Kubernetes is dropped with them.

- **Tenant web apps run on AWS Lambda.** No node is reserved for a site nobody is visiting.
- **Two Rust binaries**, both on dedicated EC2:
  - `services/router` — the front door. Resolves a hostname to a Lambda through ElastiCache,
    invokes it, and does tenant-splitting for Valkey, OpenSearch and S3. It also owns customer
    workflow dispatch (BullMQ and Celery) and its own background queue.

**There are two Valkeys and they are not the same system.** Confusing them is easy and expensive:

| | Where | Whose | What for |
| --- | --- | --- | --- |
| **Platform Valkey** | ElastiCache, in AWS | ours | hostname → Lambda resolution, billing counters, the router's own queue |
| **Tenant Valkey** | OVH, self-hosted | customers' | the data customers store, and the queues their workflows run on |

The platform one is a single small managed instance on the router's hot path, where a managed
service is worth paying for. The tenant one is many small tenants multiplexed onto shared memory,
which is exactly the shape ElastiCache prices worst — see below.
  - `services/pg-proxy` — a Postgres bouncer in front of self-hosted Neon, and the Neon control
    plane.
- **One ALB** in front of both, separated by host-based listener rules, with blue/green by switching
  target groups.
- **Stateful services on one OVH host**: OpenSearch and Valkey **for tenant data**, ClickHouse and
  Kafka for logs. Neon stays on AWS, beside the proxy that fronts it.

  The pricing research validates this rather than merely permitting it. ElastiCache Serverless is
  $0.084/GB-hour — **$61.32 per GB-month** — against $0.0102 per GiB-hour for memory on an
  `m7g.large`, an 8.2× difference before the ECPU charge. Per-tenant serverless pricing is the worst
  possible fit for multiplexing many small tenant keyspaces, so tenant Valkey belongs on hardware we
  rent whole. The platform's own instance is one instance and does not have that shape.

## Why two binaries and not one

They fail differently and they scale differently. The router is on the HTTP path of every tenant
request and its work is per-request; the Postgres proxy holds long-lived connections and its work is
per-session. Merging them means a Lambda invocation storm evicting database connections, and it
means one deploy risking both.

It also keeps the blast radius of the Postgres proxy small, which matters because it is the process
that holds an administrative credential to every tenant's database.

## Why the router owns workflows

Because it is already there. The router terminates every Valkey command a tenant sends, so it
already sees a job being enqueued — it does not need to be told. Making the customer run a worker
means the customer pays for an idle process; having the router invoke a Lambda per batch means they
pay for the work.

This is also the reason the router owns its own queue (`bullmq-official`, the first-party Rust
client): billing rollups are background work on the hot-path process, and giving that process a
queue is cheaper than giving it a second dependency.

## What this supersedes

- **0012** (Kata runtime classes for tenant isolation) — there are no pods. Lambda's isolation is
  Firecracker and AWS operates it.
- **0022** (single-label preview hostnames for Knative) — preview routing moves to the ALB and the
  router.
- **0024** (cold start vs keeping one warm, via Knative `min-scale`) — the question was
  Knative-shaped. Lambda has provisioned concurrency and it is a different trade.

Those ADRs were true when written. They are marked superseded rather than deleted, because a record
of what was believed and why is worth more than a tidy directory.

## What this costs us

**Vendor lock-in, deliberately.** The multi-cloud work proved the manifests were portable and it
cost real time to prove; that portability is now discarded. The judgement is that a platform with no
customers should optimise for the cost of running, not the cost of moving.

**A cross-provider hot path.** The router is in AWS and the OpenSearch and Valkey it splits are on
OVH, so every tenant search and every tenant queue command crosses the public internet. That is the
single largest open risk in this design and it is not yet measured — see the plan's §8a.

**No true abort for a running Lambda.** AWS exposes no API to stop an invocation in flight. The
router can stop waiting and return an error, but the function keeps running and keeps billing until
its own timeout. "Kill a long-running invocation" is therefore implemented as "cut the client off
and cap the function timeout", which recovers less cost than it sounds like.

## What stays

`services/storage-proxy`'s SigV4 verification and derived tenant secrets carry over intact into the
router — the S3 boundary moves from one bucket per service to prefixes in one shared bucket, which
is the same trade already made for Valkey and OpenSearch. `pg-proxy`'s wire protocol handling, SCRAM,
tenant identification and wake-on-connect carry over unchanged. Neon carries over entirely.
