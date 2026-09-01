import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { groupedOverhead, type MicroUsd, rateTimesQuantity } from "./money"

/**
 * What a project has cost so far, rated from its metered usage.
 *
 * `usage_rollup` holds quantity per dimension per bucket; the price book holds what a unit of each
 * dimension costs. Neither is a cost on its own, and the product is computed **at read time against
 * the book in force** rather than stored — a stored cost would be wrong the moment a rate changed,
 * and right in a way nobody could reconstruct.
 *
 * This is the generic form of `rateWorkflowRun`, which rates one run's four dimensions. Here the
 * dimensions come from whatever the project actually used.
 */

export class NoActivePriceBookError extends Error {
  override readonly name = "NoActivePriceBookError"

  constructor() {
    super("No active price_book. Rating would silently produce a free project.")
  }
}

/** Historical meters retained for reconciliation but deliberately absent from the active book. */
export const RETIRED_UNBILLABLE_DIMENSIONS = [
  "site_vcpu_second",
  "site_active_cpu_second",
  "site_ws_connection_second",
] as const

export type RatedUsage = {
  byDimension: Record<string, MicroUsd>
  usage: MicroUsd
  overhead: MicroUsd
  total: MicroUsd
}

/** The first instant of the current UTC month. What "this month" means on a bill. */
export function startOfMonth(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

/**
 * Rates every project in one organization over a period, in one pass.
 *
 * One query for the whole list rather than one per project: a dashboard with thirty projects would
 * otherwise make thirty round trips to render one screen, and the rating arithmetic is the same
 * either way.
 *
 * Projects with no metered usage are **absent from the result**, not zero — the caller decides what
 * to show, and a map that invented an entry per project would make "no usage recorded" and "usage
 * recorded as zero" indistinguishable.
 */
export async function rateProjectsForOrganization(
  db: Kysely<DB> | Transaction<DB>,
  organizationId: string,
  since: Date,
  at: Date = new Date(),
): Promise<Map<string, RatedUsage>> {
  const book = await db
    .selectFrom("priceBook")
    .select(["id", "overheadBps"])
    .where("effectiveAt", "<=", at)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  if (book === undefined) throw new NoActivePriceBookError()

  /*
    `bucket = 'day'` only.

    The same usage is rolled up at minute, hour *and* day grain, so summing across buckets would
    count everything three times. The day bucket is the coarsest and therefore the cheapest to scan
    for a month; it is also the one a monthly figure should be built from.
  */
  const rows = await db
    .selectFrom("usageRollup")
    .select([
      "projectId",
      "dimension",
      // Summed as text: `numeric(38,9)` does not fit a JavaScript number, and pg would hand back a
      // string anyway. Made explicit so nothing downstream is tempted to treat it as one.
      sql<string>`sum(greatest(quantity - externally_charged_quantity, 0))::text`.as("quantity"),
    ])
    .where("organizationId", "=", organizationId)
    .where("projectId", "is not", null)
    .where("dimension", "not in", RETIRED_UNBILLABLE_DIMENSIONS)
    .where("bucket", "=", "day")
    .where("bucketStart", ">=", since)
    .where("bucketStart", "<", at)
    .groupBy(["projectId", "dimension"])
    .execute()

  if (rows.length === 0) return new Map()

  const dimensions = [...new Set(rows.map((row) => row.dimension))]
  const items = await db
    .selectFrom("priceBookItem")
    .select(["dimension", "unitMicroUsd", "overheadBps"])
    .where("priceBookId", "=", book.id)
    .where("dimension", "in", dimensions)
    .execute()

  const rates = new Map(items.map((item) => [item.dimension, item]))

  const byProject = new Map<string, RatedUsage>()
  const subtotals = new Map<string, bigint>()
  const feeItems = new Map<string, { usageCost: MicroUsd; overheadBps: number | null }[]>()

  for (const row of rows) {
    const projectId = row.projectId
    if (projectId === null) continue

    const item = rates.get(row.dimension)
    // A dimension the price book does not carry is a seeding bug, not a free dimension. Silently
    // skipping it is how a customer's bill quietly loses a line.
    if (item === undefined) throw new NoActivePriceBookError()

    const amount = rateTimesQuantity(item.unitMicroUsd, row.quantity)
    const existing = byProject.get(projectId) ?? {
      byDimension: {},
      usage: 0n,
      overhead: 0n,
      total: 0n,
    }
    existing.byDimension[row.dimension] = amount
    byProject.set(projectId, existing)
    subtotals.set(projectId, (subtotals.get(projectId) ?? 0n) + amount)
    const projectFeeItems = feeItems.get(projectId) ?? []
    projectFeeItems.push({ usageCost: amount, overheadBps: item.overheadBps })
    feeItems.set(projectId, projectFeeItems)
  }

  for (const [projectId, subtotal] of subtotals) {
    const rated = byProject.get(projectId)
    if (rated === undefined) continue
    rated.usage = subtotal
    rated.overhead = groupedOverhead(feeItems.get(projectId) ?? [], book.overheadBps)
    rated.total = subtotal + rated.overhead
  }

  return byProject
}

/** Average daily rated project cost for reserve-aware customer warnings. */
export async function organizationBurnPerDay(
  db: Kysely<DB> | Transaction<DB>,
  organizationId: string,
  at: Date = new Date(),
): Promise<MicroUsd> {
  const since = startOfMonth(at)
  const projects = await rateProjectsForOrganization(db, organizationId, since, at)
  let total = 0n
  for (const usage of projects.values()) total += usage.total
  const elapsedDays = Math.max(1, Math.ceil((at.getTime() - since.getTime()) / 86_400_000))
  return total / BigInt(elapsedDays)
}
