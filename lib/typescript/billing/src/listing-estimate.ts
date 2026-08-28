import type { DB } from "@sproutos/db"
import { type Kysely, sql, type Transaction } from "kysely"
import { NoActivePriceBookError, RETIRED_UNBILLABLE_DIMENSIONS } from "./usage"
import { groupedOverhead, type MicroUsd, rateTimesQuantity } from "./money"

/**
 * What a store listing costs to run, from what its forks actually cost.
 *
 * The dashboard renders an em dash here, with a comment that says exactly why: "a number someone
 * plans around has to come from a curator's declared figure or the metered cost of existing forks.
 * Neither exists yet, and a plausible invented one is worse than an honest absence." That was true
 * when it was written. The second of the two exists now — projects forked from a listing carry
 * `store_listing_id`, and their usage is rolled up like everything else.
 *
 * So this is the metered answer, and it keeps the honesty the comment was protecting:
 *
 * - **The median, not the mean.** One customer running a fork at ten times everyone else's scale
 *   should not be what a stranger sees before deciding whether they can afford it.
 * - **`null` below a floor of live forks.** A "typical cost" derived from one project is that
 *   project's cost with a misleading label, and the reader has no way to know. Below
 *   `MINIMUM_SAMPLE` there is no estimate, and the em dash stays.
 * - **Full days only.** A fork installed this morning has a partial day of usage, and extrapolating
 *   it to a month would report a number several times too small — the direction of error that
 *   matters, since it is the one a customer discovers on their first bill.
 *
 * Rated at read time against the price book in force, like every other cost figure here. A stored
 * estimate is wrong the moment a rate changes, and wrong in a way nobody can reconstruct.
 */

/** Fewer live forks than this and there is no estimate, only one project's bill. */
export const MINIMUM_SAMPLE = 3

/** How far back to look. Long enough to smooth a quiet week, short enough to track a change. */
export const WINDOW_DAYS = 30

/** A month, for turning a daily rate into the figure the card shows. */
const DAYS_PER_MONTH = 30n

export type ListingEstimate = {
  storeListingId: string
  /** Micro-USD per month, including platform overhead. */
  monthlyMicroUsd: MicroUsd
  /** How many forks this was computed from. Shown so a reader can weigh it. */
  sampleSize: number
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0n
  // Two middles on an even count: their mean, floored. Money rounds down here rather than up —
  // this is an estimate shown to someone deciding whether to fork, not a charge.
  return ((sorted[middle - 1] ?? 0n) + (sorted[middle] ?? 0n)) / 2n
}

/**
 * Estimates for the listings named, keyed by listing id.
 *
 * Listings with too few forks are absent from the map rather than present with a zero, because
 * absent is what the dashboard already renders correctly.
 */
export async function estimateListingCosts(
  db: Kysely<DB> | Transaction<DB>,
  storeListingIds: readonly string[],
  at: Date = new Date(),
): Promise<Map<string, ListingEstimate>> {
  if (storeListingIds.length === 0) return new Map()

  const book = await db
    .selectFrom("priceBook")
    .select(["id", "overheadBps"])
    .where("effectiveAt", "<=", at)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  if (book === undefined) throw new NoActivePriceBookError()

  const since = new Date(at.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  // Truncated to the day boundary, so "full days only" is a fact about the query rather than an
  // intention. `bucket_start` is already day-aligned for this bucket; the cutoff has to be too, or
  // the current partial day is included and drags every estimate down.
  const until = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

  /*
    `bucket = 'day'` only, for the reason `rateProjectsForOrganization` gives: the same usage is
    rolled up at minute, hour and day grain, so summing across buckets counts everything three
    times.

    Grouped by project *and* dimension, because rating is per dimension — a project's cost is not a
    function of its total quantity across unlike units.
  */
  const rows = await db
    .selectFrom("usageRollup")
    .innerJoin("project", "project.id", "usageRollup.projectId")
    .select([
      "project.storeListingId as storeListingId",
      "usageRollup.projectId as projectId",
      "usageRollup.dimension as dimension",
      sql<string>`sum(greatest(usage_rollup.quantity - usage_rollup.externally_charged_quantity, 0))::text`.as(
        "quantity",
      ),
      // How many distinct days this project actually reported, so a fork that existed for three
      // days of the window is scaled from three days rather than from thirty.
      sql<string>`count(distinct usage_rollup.bucket_start)::text`.as("days"),
    ])
    .where("project.storeListingId", "in", storeListingIds)
    .where("project.deletedAt", "is", null)
    .where("usageRollup.bucket", "=", "day")
    .where("usageRollup.dimension", "not in", RETIRED_UNBILLABLE_DIMENSIONS)
    .where("usageRollup.bucketStart", ">=", since)
    .where("usageRollup.bucketStart", "<", until)
    .groupBy(["project.storeListingId", "usageRollup.projectId", "usageRollup.dimension"])
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

  /** listing -> project -> observed costs and the project's widest measured lifetime */
  type ProjectTotal = {
    byDimension: Map<string, { amount: bigint; overheadBps: number | null }>
    days: bigint
  }
  const perProject = new Map<string, Map<string, ProjectTotal>>()

  for (const row of rows) {
    if (row.storeListingId === null || row.projectId === null) continue

    const item = rates.get(row.dimension)
    // A dimension the price book does not carry is a seeding bug, not a free dimension — the same
    // call `rateProjectsForOrganization` makes, for the same reason.
    if (item === undefined) throw new NoActivePriceBookError()

    const byProject: Map<string, ProjectTotal> =
      perProject.get(row.storeListingId) ?? new Map<string, ProjectTotal>()
    const entry: ProjectTotal = byProject.get(row.projectId) ?? {
      byDimension: new Map(),
      days: 0n,
    }
    const amount = rateTimesQuantity(item.unitMicroUsd, row.quantity)
    const days = BigInt(row.days)
    const dimension = entry.byDimension.get(row.dimension)
    entry.byDimension.set(row.dimension, {
      amount: (dimension?.amount ?? 0n) + amount,
      overheadBps: item.overheadBps,
    })
    // The widest span across this project's dimensions. CPU measured for thirty days and egress
    // measured on one of them describes a thirty-day-old project, not one day of egress to
    // extrapolate thirtyfold.
    if (days > entry.days) entry.days = days
    byProject.set(row.projectId, entry)
    perProject.set(row.storeListingId, byProject)
  }

  const estimates = new Map<string, ListingEstimate>()

  for (const [storeListingId, byProject] of perProject) {
    const monthly: bigint[] = []

    for (const { byDimension, days } of byProject.values()) {
      if (days === 0n) continue
      let monthlyUsage = 0n
      const feeItems: { usageCost: MicroUsd; overheadBps: number | null }[] = []
      for (const dimension of byDimension.values()) {
        const monthlyAmount = (dimension.amount * DAYS_PER_MONTH) / days
        monthlyUsage += monthlyAmount
        feeItems.push({ usageCost: monthlyAmount, overheadBps: dimension.overheadBps })
      }
      const monthlyCost = monthlyUsage + groupedOverhead(feeItems, book.overheadBps)
      monthly.push(monthlyCost)
    }

    if (monthly.length < MINIMUM_SAMPLE) continue

    estimates.set(storeListingId, {
      storeListingId,
      // Median of what each fork would actually pay, including each dimension's configured fee.
      monthlyMicroUsd: median(monthly),
      sampleSize: monthly.length,
    })
  }

  return estimates
}
