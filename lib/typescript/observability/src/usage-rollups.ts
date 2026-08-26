import { clickhouse } from "./client"
import { USAGE_EVENT_RAW_TABLE } from "./schema"

export type ClickHouseUsageRollup = {
  organizationId: string
  projectId: string | null
  dimension: string
  bucket: "minute" | "hour" | "day"
  bucketStart: Date
  quantity: string
  externallyChargedQuantity: string
}

type Row = {
  organization_id: string
  project_id: string | null
  dimension: string
  bucket: ClickHouseUsageRollup["bucket"]
  bucket_start: string
  quantity: string
  externally_charged_quantity: string
}

/** A cutoff from the same clock that writes `stored_at`, taken before the affected-grain query. */
export async function clickhouseUsageWatermark(): Promise<Date> {
  const result = await clickhouse().query({
    query: "select formatDateTime(now64(3, 'UTC'), '%FT%T.%fZ', 'UTC') as now",
    format: "JSONEachRow",
  })
  const [row] = await result.json<{ now: string }>()
  if (row === undefined) throw new Error("ClickHouse returned no metering watermark")
  return new Date(row.now)
}

/**
 * Recompute absolute totals for every grain touched by newly ingested ClickHouse events.
 *
 * `FINAL` is non-negotiable: Kafka is at least once and ReplacingMergeTree deduplicates only while
 * parts merge. The first CTE chooses one version per event before either the affected-key scan or
 * the sum, so a replay cannot temporarily double a bill. `ingested_at` selects affected keys; the
 * affected-key scan uses ClickHouse's own `stored_at`, not the producer's timestamp. A Kafka record
 * delayed for days therefore still repairs its old bucket, and a replay triggers a harmless
 * absolute recomputation. The aggregate itself sees all event time.
 */
export async function usageRollupsChangedBetween(
  since: Date,
  until: Date,
): Promise<ClickHouseUsageRollup[]> {
  const result = await clickhouse().query({
    query: `
with
  changed_event_ids as (
    select distinct event_id
    from ${USAGE_EVENT_RAW_TABLE}
    where stored_at > parseDateTime64BestEffort({since:String}, 3, 'UTC')
      and stored_at <= parseDateTime64BestEffort({until:String}, 3, 'UTC')
  ),
  affected as (
    /*
      Use every version of each changed identity, not only its newest version. If a corrected event
      moves to another organization, dimension or event-time bucket, the old grain must be emitted
      with an absolute zero or Postgres keeps its previous billable total forever.
    */
    select distinct
      organization_id,
      project_id,
      dimension,
      arrayJoin(['minute', 'hour', 'day']) as bucket,
      multiIf(
        bucket = 'minute', toStartOfMinute(occurred_at),
        bucket = 'hour', toStartOfHour(occurred_at),
        toStartOfDay(occurred_at)
      ) as bucket_start
    from ${USAGE_EVENT_RAW_TABLE}
    inner join changed_event_ids using (event_id)
  ),
  deduped as (
    select * from ${USAGE_EVENT_RAW_TABLE} final
  ),
  expanded as (
    select
      organization_id,
      project_id,
      dimension,
      arrayJoin(['minute', 'hour', 'day']) as bucket,
      multiIf(
        bucket = 'minute', toStartOfMinute(occurred_at),
        bucket = 'hour', toStartOfHour(occurred_at),
        toStartOfDay(occurred_at)
      ) as bucket_start,
      quantity,
      charged_externally
    from deduped
  )
select
  affected.organization_id,
  affected.project_id,
  affected.dimension,
  affected.bucket,
  formatDateTime(affected.bucket_start, '%FT%T.000Z', 'UTC') as bucket_start,
  toString(coalesce(sum(expanded.quantity), toDecimal128(0, 9))) as quantity,
  toString(coalesce(sumIf(expanded.quantity, expanded.charged_externally), toDecimal128(0, 9)))
    as externally_charged_quantity
from affected
left join expanded
  on expanded.organization_id = affected.organization_id
 and isNotDistinctFrom(expanded.project_id, affected.project_id)
 and expanded.dimension = affected.dimension
 and expanded.bucket = affected.bucket
 and expanded.bucket_start = affected.bucket_start
group by affected.organization_id, affected.project_id, affected.dimension,
         affected.bucket, affected.bucket_start
order by affected.organization_id, affected.project_id, affected.dimension,
         affected.bucket, affected.bucket_start
`,
    query_params: { since: since.toISOString(), until: until.toISOString() },
    format: "JSONEachRow",
  })

  return (await result.json<Row>()).map((row) => ({
    organizationId: row.organization_id,
    projectId: row.project_id,
    dimension: row.dimension,
    bucket: row.bucket,
    bucketStart: new Date(row.bucket_start),
    quantity: row.quantity,
    externallyChargedQuantity: row.externally_charged_quantity,
  }))
}
