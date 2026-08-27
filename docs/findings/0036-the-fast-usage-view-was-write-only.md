# 0036 — The fast usage view was write-only

The raw-usage cutover itself is real. Current migrations drop PostgreSQL `usage_event`; signed and
transactional producers publish stable event ids to the dedicated Kafka topic; ClickHouse keeps the
raw `ReplacingMergeTree(version)` history; financial reads use `FINAL`; and an absolute importer
projects affected minute, hour, and day grains into PostgreSQL `usage_rollup`.

At audit time, Valkey did not complete the other half of ADR 0028. The only references to
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

## Resolution

The active projection is now generation-based. Reconciliation creates a blank generation, reads
authoritative ClickHouse `FINAL` rows in bounded event-id pages, replays the bounded pending view,
and atomically switches the reader pointer. Producers dual-write to the live and building
generations. Each event marker stores the decimal ClickHouse version and exact contribution, so a
newer version subtracts the old contribution while an older query page cannot replace a concurrent
write.

The pending hash closes the Kafka-consumer lag window: a direct writer records its latest version
there, and reconciliation removes it only after ClickHouse presents that version or a newer one.
Partial bucket eviction is repaired by the blank generation rather than by assigning an old
aggregate over a live counter. Superseded generations are removed through bounded `SSCAN`/`UNLINK`
passes and also retain a TTL as the final cleanup boundary.

## Current gap matrix

| Requirement                                                   | State               | Evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClickHouse is durable raw usage authority                     | Verified            | `usage_event_raw` is a monthly `ReplacingMergeTree(version)`; financial rollups query `FINAL`; backup, DLQ health, and restore scripts exist. On 2026-08-27 the OVH health timer reported a fresh S3 backup and empty DLQ, and the isolated restore drill reproduced the manifest's 45 rows and checksum.                                                                                                                               |
| PostgreSQL raw partitions are retired                         | Implemented         | The final migration cancels legacy `billing.roll_up_usage` jobs and drops `usage_event`; generated DB types expose `usageRollup`, `meteringOutbox`, and `meteringImportState`, but no raw usage table. Existing history was intentionally not migrated because production had no customer billing history to preserve.                                                                                                                  |
| Transactional TypeScript emitters cannot lose committed usage | Implemented in code | Agent, sandbox, workflow, and Valkey sampling write the exact Kafka payload to `metering_outbox` in their owning transaction. The relay deletes only after bounded Kafka and current Valkey delivery.                                                                                                                                                                                                                                   |
| Valkey is only a fast projection                              | Verified            | Billing does not read it. The exported reader resolves the atomic current-generation pointer, and the hourly job rebuilds that generation from ClickHouse. On 2026-08-27 the production job rebuilt 2 organizations from 2,503 ClickHouse events with no pending events; a direct ElastiCache scan found both atomic current-generation pointers and 2,554 projection keys. Prompt/quota behavior remains a separate consumer decision. |
| Cache loss and corrections converge from ClickHouse           | Verified            | Version-aware generation writes, the pending handoff, and a blank ClickHouse rebuild cover duplicates, corrections, eviction, and concurrent ingest. The same production run removed 2,507 stale keys and completed within every configured organization/event/page/cleanup bound.                                                                                                                                                      |
| Production durability is proved                               | Verified            | The OVH backup and health timers are active. Backup `usage-20260827T033638Z` restored into `sproutos_restore_drill` with 45 rows, checksum `13825102886571803571`, and zero DLQ rows; the script then dropped the isolated drill database.                                                                                                                                                                                              |

The implementation is deliberately not a periodic `HSET` of ClickHouse totals. That can
overwrite a newer synchronous increment when an event arrives between the ClickHouse query and the
Valkey write. Nor is replaying every raw event through the current idempotency script sufficient:
a surviving seen-marker plus an evicted bucket suppresses the contribution. Blank generations,
dual-write, pending versions, and an atomic pointer handoff provide the missing ordering.

The remaining boundary is:

- billing and statements continue to read only absolute PostgreSQL rollups imported from
  deduplicated ClickHouse rows;
- product prompt/quota code must use the current-generation reader rather than constructing Valkey
  keys or treating a stale generation as authoritative;
- Valkey remains fail-open enforcement state and is never a financial input.

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

The reconciliation job, version-aware Lua transition, pending handoff, and race/eviction tests stop
the projection drift described here. Product-specific prompt feedback or usage-based enforcement is
still separate launch work, not a reason to restore PostgreSQL raw partitions.
