import { clickhouse } from "@lib/observability"

/**
 * Deleting one organization's logs from ClickHouse.
 *
 * The log table's retention is a per-row TTL, so a project that stops sending logs is emptied
 * within its retention window without anyone doing anything. That is enough for retention and not
 * enough for deletion: a customer who closes their account is not asking us to stop keeping their
 * logs in ninety days' time.
 *
 * `log_record` is partitioned by day, which makes *retention* a metadata operation — dropping a
 * partition is instant. It does nothing for us here, because an organization's rows are spread
 * across every partition it ever logged into and a partition holds every organization that logged
 * that day. There is no partition to drop, so the rows have to be deleted.
 */

/**
 * Remove every log row belonging to an organization.
 *
 * A lightweight `DELETE`, which marks the rows invisible immediately and lets a background merge
 * rewrite the parts without them. The heavier `ALTER TABLE … DELETE` mutation rewrites every
 * affected part synchronously, which on a shared table means rewriting parts that are mostly other
 * customers' data — hours of IO to delete a few thousand rows.
 *
 * `mutations_sync = 2` so this call does not return until the delete is durable on the replica.
 * Returning early would let the caller stamp the organization purged while its rows were still
 * readable, and the stamp is what stops us ever looking again.
 */
export async function purgeOrganizationLogs(organizationId: string): Promise<void> {
  const client = clickhouse()

  await client.command({
    // Parameterized: `organizationId` reaches here from a database row rather than a request, but
    // the day someone calls this with a value a customer chose is the day the difference matters.
    query: "delete from log_record where organization_id = {organizationId:UUID}",
    query_params: { organizationId },
    clickhouse_settings: { mutations_sync: "2" },
  })
}
