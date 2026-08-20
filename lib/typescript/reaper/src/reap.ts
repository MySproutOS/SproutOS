import { tenantIndexPrefix } from "@lib/services/tenant-auth"
import type { DB } from "@sproutos/db"
import { Redis } from "ioredis"
import type { Kysely } from "kysely"
import { purgeOrganizationLogs } from "./logs"
import { purgeTenantIndices, type SearchAdminConfig } from "./search"
import { purgeTenantKeys } from "./valkey"

/**
 * Finishing a deletion.
 *
 * A `destroy` call revokes the tenant's credential and stamps `deleted_at`, and stops there. This
 * is what makes the data actually stop existing, in the three stores that are not Postgres and
 * therefore have no foreign key to cascade along.
 *
 * It is deliberately a separate pass rather than more work inside `destroy`, and the reason is
 * failure rather than latency. Deleting an index is a cluster operation that can fail, retry and
 * fail again; if that happened inside the request, a customer's delete would return 500 with the
 * service already revoked and nothing scheduled to try again. Here a failure is a job that runs
 * again in an hour, and the only thing an unfinished purge costs is disk.
 */

export type ReaperDependencies = {
  /** The shared Valkey, reached directly. The proxy cannot help: we cannot authenticate as a
   * tenant whose secret we only ever stored as a hash. */
  valkeyUrl: string
  search: SearchAdminConfig
  /** Set false where ClickHouse is not configured — logs are then left to their per-row TTL. */
  logs: boolean
}

export type ReapedService = {
  backendServiceId: string
  kind: string
  /** Valkey keys unlinked, or indices deleted. Zero is a normal outcome for a service nobody used. */
  removed: number
}

export type ReapReport = {
  services: ReapedService[]
  organizations: string[]
}

/**
 * How many rows one pass handles.
 *
 * Small on purpose. Each service is a round trip to another system, and a pass that tried to drain
 * a backlog of thousands would hold its job lease for long enough to be reclaimed as expired and
 * run again concurrently. Running every hour, this drains far faster than customers delete things.
 */
const PER_PASS = 25

/**
 * Purge the stores for services whose `destroy` marked them deleted.
 *
 * Ordered oldest first, so a backlog drains in the order the deletions were requested rather than
 * leaving the oldest one — the one that has been costing us shards the longest — for last.
 */
export async function reapDeletedServices(
  db: Kysely<DB>,
  deps: ReaperDependencies,
): Promise<ReapedService[]> {
  const pending = await db
    .selectFrom("backendService")
    .select(["id", "kind"])
    .where("deletedAt", "is not", null)
    .where("purgedAt", "is", null)
    .orderBy("deletedAt", "asc")
    .limit(PER_PASS)
    .execute()

  if (pending.length === 0) return []

  const reaped: ReapedService[] = []
  // One connection for the whole pass rather than one per service: opening a socket per deleted
  // queue would cost more than the deletes.
  const redis = pending.some((row) => row.kind === "valkey") ? new Redis(deps.valkeyUrl) : undefined

  try {
    for (const service of pending) {
      let removed = 0

      if (service.kind === "valkey" && redis !== undefined) {
        removed = (await purgeTenantKeys(redis, service.id)).deleted
      } else if (service.kind === "elasticsearch") {
        removed = (await purgeTenantIndices(deps.search, tenantIndexPrefix(service.id))).length
      }
      /*
        `postgres` is absent on purpose, and is not an oversight.

        The Postgres driver drops the database and the role inside `destroy`, because it can: those
        are two statements against a server we administer, they are transactional in the sense that
        matters, and `drop database … with (force)` cannot be left half-done. There is nothing for a
        reaper to finish. The stamp below still applies, so the row leaves the queue.
      */

      await stampPurged(db, "backendService", service.id)
      reaped.push({ backendServiceId: service.id, kind: service.kind, removed })
    }
  } finally {
    await redis?.quit()
  }

  return reaped
}

/**
 * Purge the stores for organizations that were soft-deleted.
 *
 * Only the logs. Everything else an organization owns is reached through a `backend_service` row,
 * which the delete path destroys individually and the pass above then purges — going after them
 * again from here would be a second code path deleting the same data, with the usual result that
 * the two disagree about what "everything" means.
 *
 * Logs are the exception because nothing owns them: `log_record` carries `organization_id` as a
 * column in another database entirely, so a deleted organization's logs are reachable by no row and
 * no cascade, and would otherwise sit there until the last one aged out of its retention window.
 */
export async function reapDeletedOrganizations(
  db: Kysely<DB>,
  deps: ReaperDependencies,
): Promise<string[]> {
  const pending = await db
    .selectFrom("organization")
    .select("id")
    .where("deletedAt", "is not", null)
    .where("purgedAt", "is", null)
    .orderBy("deletedAt", "asc")
    .limit(PER_PASS)
    .execute()

  const purged: string[] = []
  for (const organization of pending) {
    /*
      Wait for every service the organization owns before purging it.

      A service is purged by the pass above and an organization by this one, and both stamp
      independently. If the organization were stamped first and its services' purge then failed
      forever, the organization would look finished while its indices sat on the cluster — and
      nothing would be looking at the organization any more to notice.
    */
    const unfinished = await db
      .selectFrom("backendService")
      .select("id")
      .where("organizationId", "=", organization.id)
      .where("purgedAt", "is", null)
      .limit(1)
      .executeTakeFirst()

    if (unfinished !== undefined) continue

    if (deps.logs) await purgeOrganizationLogs(organization.id)
    await stampPurged(db, "organization", organization.id)
    purged.push(organization.id)
  }

  return purged
}

export async function reap(db: Kysely<DB>, deps: ReaperDependencies): Promise<ReapReport> {
  return {
    services: await reapDeletedServices(db, deps),
    organizations: await reapDeletedOrganizations(db, deps),
  }
}

async function stampPurged(
  db: Kysely<DB>,
  table: "backendService" | "organization",
  id: string,
): Promise<void> {
  await db.updateTable(table).set({ purgedAt: new Date() }).where("id", "=", id).execute()
}
