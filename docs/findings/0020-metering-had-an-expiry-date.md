# 0020 — Metering had an expiry date

`usage_event` looked like a durable table. It was a partitioned parent with eight daily children:
yesterday through seven days after the migration ran. PostgreSQL does not create the ninth child.

After that midnight, an otherwise valid insert fails with `no partition of relation "usage_event"
found for row`. The ingest route returns 500, while the LLM proxy's former one-shot delivery logged
the failure and discarded the batch. Agent and sandbox jobs failed their whole operation. The
platform's billable activity did not stop; only its record did.

## Why the partition existed

The intent was reasonable. Metering grows without bound, and time partitions keep indexes smaller
and make retention a cheap partition drop rather than a huge `DELETE`. The failure was treating a
one-time migration loop as ongoing lifecycle management. The schema encoded a calendar deadline
that no job owned.

## Why the obvious fix was not the final fix

A default partition was added as a temporary bridge so the cutover could not race midnight. The
legacy hardening plan proposed a permanent ahead-of-time partition job and a clock-forward test.
That would keep Postgres accepting rows, but it would preserve the wrong long-term store.

ADR 0028 moves raw events through Kafka into monthly ClickHouse partitions, keeps current counters
in Valkey, and imports absolute aggregates into Postgres. The final migration cancels the retired
rollup jobs and drops the parent table. There is no daily Postgres child left to forget.

## The evidence boundary

The implementation followed two earlier programs whose reports must not be blurred together:

- `private_notes/groups.md` and
  `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` describe the legacy product
  deployment and what it actually proved in production.
- `private_notes/sandbox-handoff.md` says plainly that the earlier sandbox verification used Docker,
  while production uses Daytona.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` found this deadline and remains the plan for
  the broader Valkey, OpenSearch, metering-dimension, and enforcement work.

Those records are preserved. This finding reports the storage cutover only; it does not convert a
stubbed model response, a Docker sandbox, validated OpenTofu, or unmerged proxy hardening into
production proof.

## What stops it coming back

- There is no raw Postgres usage table or legacy additive rollup handler.
- The ClickHouse importer throws when its authoritative store is unconfigured.
- Kafka publication waits for all replicas; outbox rows survive failures and retries use stable
  event ids.
- ClickHouse tests advance storage time beyond event time, replay duplicates, and move a corrected
  event between grains while asserting the old grain becomes zero.
- The cross-language dimension fixture prevents one producer from inventing a value a downstream
  constraint silently refuses.
