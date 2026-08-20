# @lib/queue

Reading and editing jobs in a tenant's queue — the control-plane half of TASK 35.

> For workflows, users should be able to peer into jobs. This is a permission that goes into our
> RBAC thing. Users can also modify job data.

## Why this is not a database query

`workflow_run` records that a run happened, when, and what it cost. It has **no `input` column**,
because the payload is not ours: it lives in Valkey, where the tenant's BullMQ client put it. So
peering into a job means reaching into the tenant's keyspace, and editing one means writing to it.

## The two prefixes

A tenant's worker connects through `services/valkey-proxy`, which prepends `{kv:<short-id>}:` to
every key. The tenant's own BullMQ then prepends `bull`. The key that actually exists is:

```
{kv:01j4pkz2hbfh6sw7sa7d65tvkz}:bull:emails:42
└──────────── the proxy ──────┘└ BullMQ ┘
```

The control plane connects to that Valkey **directly** and has to apply both halves itself.

Going through the proxy is not an option even in principle: the tenant's secret is stored as a
one-way hash, so there is nothing to authenticate with. That is the property that makes a stolen
`service_credential` table worthless, and it is worth more than the convenience.

`bull` is BullMQ's default and SproutOS does not change it, because SproutOS _generates_ the worker
code for a workflow — the queue is created by code we wrote, so the prefix is not a customer choice
we would have to discover. A queue a customer wrote by hand may use any prefix it likes; TASK 35 is
about workflow jobs.

## Why BullMQ rather than hand-written RESP

A job is not one key. It is a hash, plus membership in one of several lists and sorted sets that
together _are_ its state, and `updateData` is a Lua script that respects the lock a worker holds.
Reimplementing that from the key layout would be reimplementing the part where being wrong corrupts
a customer's queue.

## Which jobs can be edited

`waiting`, `waiting-children`, `delayed`, `prioritized`. Everything else is refused, for two
different reasons:

- **`active`** — a worker already holds this payload in memory. Editing the hash would change what
  the _next_ attempt sees while the attempt already running carries on with the old data. The audit
  row would then describe an edit that did not take effect, and silently doing nothing is worse than
  saying no.
- **`completed` / `failed`** — the job has run. Changing its input afterwards edits the record of
  what happened, which is the one thing an audit trail exists to prevent.

There is still a race: a worker can claim the job between the state check and the write. BullMQ
closes it, because `updateData` is a Lua script and a job that moved is no longer where the script
looks. The honest description is that this refuses an edit it can _see_ is unsafe, not that it holds
a lock.

## The audit row

Written by the API in the same request, **after** the queue accepts the edit. The other order would
record edits that never landed, and a trail containing things that did not happen cannot be used to
work out what did.

The `before` value comes from the same read that checked the state, so it is the data this edit
actually replaced rather than a second read that could have caught the job mid-change.

`workflow_job_edit_audit.reason` is `NOT NULL` and the API requires eight characters. A row saying
only who and when answers none of the questions asked after someone edits what a customer's workflow
is about to do to a customer's data. The table is append-only, enforced by a trigger, and its
foreign key to `workflow_run` is `RESTRICT` — so the history cannot be swept away by deleting the
run it describes.

## Configuration

`SERVICE_VALKEY_ADMIN_URL` — the shared Valkey tenant queues live on.

Deliberately **not** `VALKEY_URL`, which is the control plane's own cache. Pointing job inspection at
that in production would have the API looking for a customer's jobs in the wrong instance and
truthfully reporting that they do not exist.

## Testing

```bash
docker compose up -d
pnpm --filter=@lib/queue exec vitest run
```

A real BullMQ producer writes to the compose Valkey and a real `Worker` drives a job to completion —
`moveToCompleted` needs the job active and holding the lock, which is the very reason an edit is
refused at that point, so faking the transition would test the refusal against a state BullMQ never
produces.

The route-level tests are in `apps/internal-api/src/v1/workflow-jobs.test.ts`, and they assert the
expected Valkey key **spelled out** rather than derived from `tenantQueuePrefix`. Deriving it made
the assertion agree with the function under test by construction: dropping the namespace moved the
write and the read together, and the test went on passing while every tenant shared one keyspace.

## Not built yet

- **Celery.** `tenant_queue.driver` allows it and its key layout is entirely different. Refused with
  a clear message rather than half-supported.
- **Cancelling, retrying, and reprioritising.** BullMQ exposes all three; TASK 35 asks for reading
  and modifying data, and each of the others needs its own audit semantics.
