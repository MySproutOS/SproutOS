# 0036 — The fast usage view was write-only

The raw-usage cutover itself is real. Current migrations drop PostgreSQL `usage_event`; signed and
transactional producers publish stable event ids to the dedicated Kafka topic; ClickHouse keeps the
raw `ReplacingMergeTree(version)` history; financial reads use `FINAL`; and an absolute importer
projects affected minute, hour, and day grains into PostgreSQL `usage_rollup`.

Valkey does not yet complete the other half of ADR 0028. The only references to
`metering:active:v1` outside tests are writes from signed ingest and the transactional outbox. No
prompt, quota, credit, or billing path reads those hashes. No job rebuilds them from ClickHouse.
The outbox source comment already said “until an actual ClickHouse-to-Valkey rebuild job exists,”
but the ADR diagram made Kafka appear to feed Valkey and described the counters as a view already
used for feedback and enforcement.

That distinction matters because valid cache behavior loses this state. Both daily hashes and
event-id markers expire after 40 days. Eviction after an acknowledged write has no replay owner:
the Kafka consumer offset has advanced, the HTTP emitter received success, and a TypeScript outbox
row was deleted. The idempotency marker also implements first-seen semantics, while ClickHouse uses
latest `version` semantics. A corrected event with the same id replaces financial history in
ClickHouse but remains the old quantity in Valkey.

## Current gap matrix

| Requirement                                                   | State               | Evidence and remaining work                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClickHouse is durable raw usage authority                     | Implemented in code | `usage_event_raw` is a monthly `ReplacingMergeTree(version)`; financial rollups query `FINAL`; backup, DLQ health, and restore scripts exist. The OVH backup and restore drill remain production-verification pending.                                                                                                 |
| PostgreSQL raw partitions are retired                         | Implemented         | The final migration cancels legacy `billing.roll_up_usage` jobs and drops `usage_event`; generated DB types expose `usageRollup`, `meteringOutbox`, and `meteringImportState`, but no raw usage table. Existing history was intentionally not migrated because production had no customer billing history to preserve. |
| Transactional TypeScript emitters cannot lose committed usage | Implemented in code | Agent, sandbox, workflow, and Valkey sampling write the exact Kafka payload to `metering_outbox` in their owning transaction. The relay deletes only after bounded Kafka and current Valkey delivery.                                                                                                                  |
| Valkey is only a fast projection                              | Partly implemented  | It is not used for financial reads, which is correct. It is also not read anywhere, rebuilt, or reconciled, so it cannot truthfully be called the current enforcement view yet.                                                                                                                                        |
| Cache loss and corrections converge from ClickHouse           | Missing             | Build a version-aware projector with a stored ClickHouse watermark and a generation or equivalent handoff that is safe under concurrent ingestion. Prove full eviction recovery, partial-key loss, duplicate delivery, a newer version changing quantity/dimension/project, and an event arriving during rebuild.      |
| Production durability is proved                               | Unproven            | Apply the OVH durability setup, observe the usage consumer and DLQ health, complete an initial S3 backup, restore it into the drill database, and compare the manifest. Repository validation is not that production proof.                                                                                            |

The smallest safe next implementation is not a periodic `HSET` of ClickHouse totals. That can
overwrite a newer synchronous increment when an event arrives between the ClickHouse query and the
Valkey write. Nor is replaying every raw event through the current idempotency script sufficient:
a surviving seen-marker plus an evicted bucket suppresses the contribution. The repair needs an
explicit projection generation or another atomic handoff, plus version-aware replacement semantics.

Until that exists:

- billing and statements continue to read only absolute PostgreSQL rollups imported from
  deduplicated ClickHouse rows;
- `metering:active:v1` must not be used to deny work or shown as complete current usage;
- Valkey failure after Kafka durability remains retryable at the current producer boundaries, but
  this is a temporary delivery tactic, not a durability guarantee for the cache.

## Evidence boundary and legacy record

This audit used the two legacy plans and both handoff records rather than replacing their account
of what happened:

- `private_notes/groups.md` is the original grouped implementation and reporting record.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` separates deployed product
  work from what was only planned or locally exercised.
- `private_notes/sandbox-handoff.md` says plainly that the first sandbox verification ran against a
  Docker driver, not Daytona, and lists the then-unapplied production dependencies.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` found the PostgreSQL partition deadline and
  defines the broader datastore metering and enforcement work.

Those sources do not invalidate the ClickHouse cutover now present on `main`, and the current code
does not retroactively prove their Daytona, real-model, or production-apply gaps. This finding is
specifically the remaining usage-storage/projection boundary.

## What stops the old partition failure coming back

- The migrated PostgreSQL schema has no `usage_event` relation or partition lifecycle.
- The old additive rollup job has no registered kind or handler, and the drop migration cancels
  claimable legacy rows.
- The ClickHouse importer fails visibly when ClickHouse is unconfigured and advances its cursor in
  the same transaction as absolute rollup assignment.
- Kafka retries keep stable event ids, and every financial ClickHouse aggregation deduplicates
  before summing.

What does **not** stop Valkey projection drift yet is equally explicit above; that is launch work
for prompt feedback or usage-based enforcement, not a reason to restore PostgreSQL raw partitions.
