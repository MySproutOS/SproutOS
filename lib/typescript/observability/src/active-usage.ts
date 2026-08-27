import { clickhouse } from "./client"
import { USAGE_EVENT_RAW_TABLE } from "./schema"

export type ActiveUsageRow = {
  eventId: string
  organizationId: string
  projectId: string | null
  dimension: string
  quantity: string
  occurredAt: Date
  version: string
}

type Row = {
  event_id: string
  organization_id: string
  project_id: string | null
  dimension: string
  quantity: string
  occurred_at_text: string
  version: string
}

/**
 * Read one bounded, keyset-paginated page of the authoritative active usage window.
 *
 * `FINAL` is required for the same reason as financial rollups: Kafka delivery is at least once
 * and a newer version replaces the old contribution. Reconciliation starts a blank Valkey
 * generation, so rows missing from this result cannot survive merely because an older cache
 * generation remembered them.
 */
export async function activeUsageEventsPage(
  organizationId: string,
  since: Date,
  afterEventId: string,
  limit: number,
): Promise<ActiveUsageRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("active usage page size must be between 1 and 1000")
  }

  const result = await clickhouse().query({
    query: `
select
  event_id,
  organization_id,
  project_id,
  dimension,
  toString(quantity) as quantity,
  formatDateTime(occurred_at, '%FT%T.%fZ', 'UTC') as occurred_at_text,
  toString(version) as version
from ${USAGE_EVENT_RAW_TABLE} final
where organization_id = toUUID({organizationId:String})
  and occurred_at >= parseDateTime64BestEffort({since:String}, 3, 'UTC')
  and event_id > {afterEventId:String}
order by event_id
limit {limit:UInt32}
`,
    query_params: {
      organizationId,
      since: since.toISOString(),
      afterEventId,
      limit,
    },
    format: "JSONEachRow",
  })

  return (await result.json<Row>()).map((row) => ({
    eventId: row.event_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    dimension: row.dimension,
    quantity: row.quantity,
    occurredAt: new Date(row.occurred_at_text),
    version: row.version,
  }))
}
