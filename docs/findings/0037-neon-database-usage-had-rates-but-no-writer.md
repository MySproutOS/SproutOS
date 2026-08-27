# 0037 — Neon database usage had rates but no writer

The price book charged `db_compute_cu_second` and `db_storage_gib_hour`, and the billing UI knew how
to display both. Nothing emitted either dimension. A customer database could consume Neon compute
and storage indefinitely while the bill continued to show no database line at all.

## Why a local counter is not the answer

SproutOS does not sit on Neon's compute or storage data path. Connection counts, endpoint state, or
periodic project-detail snapshots are not invoice quantities and cannot be made authoritative by
polling them more often. Neon now exposes invoice-aligned project consumption history through
`GET /consumption_history/v2/projects`, including hourly `compute_unit_seconds`,
`root_branch_bytes_month`, and `child_branch_bytes_month`. Reading it does not wake suspended
computes. Those properties come from Neon's
[current API reference](https://api-docs.neon.tech/reference/getconsumptionhistoryperprojectv2),
not from project-detail counters or an inferred SDK shape.

The poller reads only closed hourly windows behind a settlement lag. It writes stable raw usage
events to the existing transactional metering outbox and advances a per-database watermark in the
same PostgreSQL transaction. Provider errors advance nothing. Concurrent and retried jobs can ask
Neon for the same interval, but the database lock, watermark, stable event id, and downstream
ClickHouse replacement semantics keep one authoritative value.

Neon's compute unit-seconds already match the price-book unit. Storage is supplied as byte-months,
so the writer converts with the price book's documented 730-hour month:
`byte_month * 730 / 2^30`. The original provider integers and conversion name remain in event
attributes so an invoice can be reconciled without reverse engineering the transformed quantity.

## A nearby rate was also dishonest

`site_ws_connection_second` had a price even though the router strips `Upgrade` and the product does
not support WebSockets. No truthful writer is possible. The forward migration removes that unused
rate from existing books, the seed no longer advertises it, and new events no longer accept it.
Historical database constraints remain wide enough to read old rows; absence still means
unmeasured, never invented zero usage.

## Evidence boundary and prior plans

This closes the two Neon writers identified in Part C of
`/Users/andrew/.claude/plans/double-sorted-meteor.md`. It preserves the reporting boundary from
`private_notes/groups.md`, `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, and
`private_notes/sandbox-handoff.md`: unit and PostgreSQL integration tests prove the durable local
path, while official Neon documentation proves the API contract. On 2026-08-27 the configured
Launch-plan credential queried a closed two-hour window through this client and Neon returned all
four organization projects. That proves entitlement and request compatibility; the production job
still has to run after deployment before its emitted usage is verified.

## What stops it coming back

- The Neon client test pins the v2 path, requested metrics, closed range, and cursor pagination.
- A real-PostgreSQL concurrency test emits compute and storage once, advances the watermark with the
  outbox rows, makes a same-hour retry a no-op, and proves provider failure cannot advance state.
- The scheduler test requires a durable hourly Neon metering job.
- Billing regression coverage no longer classifies either database dimension as writerless, while
  unsupported WebSocket usage remains absent and unpriced.
