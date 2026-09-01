-- Runtime logs from customers' Lambda functions.
--
-- Retention is three days and it is expressed in the table rather than in a cron job, because a
-- deletion policy that lives outside the schema is one nobody finds when they wonder why the disk
-- is full.

CREATE DATABASE IF NOT EXISTS sproutos;

CREATE TABLE IF NOT EXISTS sproutos.runtime_log
(
    -- Millisecond precision. Lambda emits it, and a log viewer that cannot order two lines from the
    -- same second is not a log viewer.
    ts            DateTime64(3) CODEC(Delta, ZSTD(1)),
    -- Arrival time is the stream order. Kafka may deliver a record whose Lambda timestamp is
    -- older than the last line already displayed; ordering the stream by ts would lose it.
    ingested_at   DateTime64(3) DEFAULT ts CODEC(Delta, ZSTD(1)),
    -- Set by the router before Kafka, and therefore stable across an at-least-once replay.
    ingest_id     String DEFAULT hex(SHA256(concat(
                        toString(toUnixTimestamp64Milli(ts)), '\0',
                        toString(deployment_id), '\0', request_id, '\0', level, '\0', message, '\0',
                        ifNull(toString(duration_ms), ''), '\0', ifNull(toString(billed_ms), ''), '\0',
                        ifNull(toString(memory_mb), ''), '\0', ifNull(toString(init_ms), ''), '\0',
                        ifNull(toString(cold_start), '')
                      ))) CODEC(ZSTD(1)),
    -- Kafka's partition/offset is the durable arrival sequence. A project is keyed to one
    -- partition by the router; replaying an offset names the same observation.
    ingest_partition UInt16 DEFAULT 0,
    ingest_offset    UInt64 DEFAULT 0,
    project_id    UUID,
    deployment_id UUID,
    request_id    String        CODEC(ZSTD(1)),
    level         LowCardinality(String),
    message       String        CODEC(ZSTD(3)),
    -- `platform.report` fields, present only on the final record of an invocation. Nullable rather
    -- than zero: a cold start of 0 ms and "this line is not a report" are different facts.
    duration_ms   Nullable(Float32),
    billed_ms     Nullable(UInt32),
    memory_mb     Nullable(UInt16),
    init_ms       Nullable(Float32),
    cold_start    Nullable(Bool)
)
ENGINE = MergeTree
-- Partitioned by day so expiry drops whole parts rather than rewriting them. The cost is that
-- retention lands between three and four days rather than exactly three, which is the right trade
-- for logs.
PARTITION BY toDate(ts)
-- Project first: every query a customer runs is scoped to one, and the index should say so before
-- it says anything about time.
ORDER BY (project_id, ts, request_id)
TTL toDateTime(ts) + INTERVAL 3 DAY DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- Searching message text is the point of the log viewer, and a full scan of three days of one
-- project's logs is not fast enough. A token bloom filter is cheap in space — unlike a full text
-- index, which ClickHouse's own benchmark measures at 215 GiB against 7 GiB for this.
ALTER TABLE sproutos.runtime_log
    ADD INDEX IF NOT EXISTS message_tokens message TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;
