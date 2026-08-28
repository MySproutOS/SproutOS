import { groupedOverhead, type MicroUsd, rateTimesQuantity } from "@lib/billing/money"
import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"

/**
 * What a workflow run costs (TASK 25).
 *
 * > For workflows, we bill based on number of jobs, size of the job in valkey, and how long it's
 * > been in valkey in addition to the actual execution.
 *
 * Four dimensions, and the middle two are the reason `workflow_run.bytes_enqueued` and
 * `valkey_dwell_ms` exist as columns. Until now nothing wrote them and nothing rated them.
 *
 * The dwell dimension is the one people find surprising, and it is the one that reflects reality:
 * a job sitting in a queue for six hours is holding memory on a Valkey instance we pay for the
 * whole time, whether or not it ever runs.
 */

export type WorkflowUsage = {
  /** How many jobs the run enqueued. Charged per job — `workflow_job_enqueued`. */
  jobsEnqueued: number
  /** The payload's size in Valkey, and how long it sat there. */
  bytesEnqueued: bigint | null
  dwellMs: bigint | null
  /** Actual execution, in vCPU-seconds and GiB-seconds. */
  vcpuSeconds: number
  gibSeconds: number
}

export type RatedWorkflowRun = {
  byDimension: Record<string, MicroUsd>
  usage: MicroUsd
  overhead: MicroUsd
  total: MicroUsd
  /** False when one or more quantities were never measured, rather than measured as zero. */
  complete: boolean
  missingDimensions: string[]
}

export class NoActivePriceBookError extends Error {
  override readonly name = "NoActivePriceBookError"

  constructor() {
    super("No active price_book. Rating would silently produce a free workflow run.")
  }
}

const DIMENSIONS = [
  "workflow_job_enqueued",
  "valkey_queue_byte_second",
  "workflow_exec_vcpu_second",
  "workflow_exec_gib_second",
] as const

/**
 * Rate one run.
 *
 * `valkey_queue_byte_second` is bytes × seconds, which is why the two columns are stored
 * separately rather than as a single "queue cost": the product is computed at rating time against
 * the price book that was in force, and either factor alone is meaningless.
 *
 * The rate is 0.000001 micro-USD per byte-second — the dimension that would floor to zero as an
 * integer, and the reason `price_book_item.unit_micro_usd` is `numeric(38,9)`.
 */
export async function rateWorkflowRun(
  db: Kysely<DB> | Transaction<DB>,
  usage: WorkflowUsage,
  at: Date = new Date(),
): Promise<RatedWorkflowRun> {
  const book = await db
    .selectFrom("priceBook")
    .select(["id", "overheadBps"])
    .where("effectiveAt", "<=", at)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  if (book === undefined) throw new NoActivePriceBookError()

  const items = await db
    .selectFrom("priceBookItem")
    .select(["dimension", "unitMicroUsd", "overheadBps"])
    .where("priceBookId", "=", book.id)
    .where("dimension", "in", [...DIMENSIONS])
    .execute()

  const rates = new Map(items.map((item) => [item.dimension, item]))
  const quantities = quantitiesFor(usage)
  const missingDimensions = DIMENSIONS.filter((dimension) => quantities[dimension] === null)

  const byDimension: Record<string, MicroUsd> = {}
  let subtotal = 0n
  const feeItems: { usageCost: MicroUsd; overheadBps: number | null }[] = []

  for (const dimension of DIMENSIONS) {
    const quantity = quantities[dimension]
    if (quantity === null) continue
    if (quantity === "0") continue

    const item = rates.get(dimension)
    // A dimension the price book does not carry is a seeding bug, not a free dimension.
    if (item === undefined) throw new NoActivePriceBookError()

    const amount = rateTimesQuantity(String(item.unitMicroUsd), quantity)
    byDimension[dimension] = amount
    subtotal += amount
    feeItems.push({ usageCost: amount, overheadBps: item.overheadBps })
  }

  const platformOverhead = groupedOverhead(feeItems, book.overheadBps)

  return {
    byDimension,
    usage: subtotal,
    overhead: platformOverhead,
    total: subtotal + platformOverhead,
    complete: missingDimensions.length === 0,
    missingDimensions,
  }
}

/**
 * Quantities as decimal strings, because byte-seconds overflow anything smaller.
 *
 * A 1 MB payload sitting in a queue for a day is 8.6e10 byte-seconds — fine in a float until it
 * is not, and `rateTimesQuantity` works in bigint precisely so the arithmetic never becomes
 * approximate on the way to a bill.
 */
export function quantitiesFor(
  usage: WorkflowUsage,
): Record<(typeof DIMENSIONS)[number], string | null> {
  const byteSeconds =
    usage.bytesEnqueued === null || usage.dwellMs === null
      ? null
      : (usage.bytesEnqueued * usage.dwellMs) / 1000n

  return {
    workflow_job_enqueued: String(Math.max(0, usage.jobsEnqueued)),
    valkey_queue_byte_second:
      byteSeconds === null ? null : (byteSeconds < 0n ? 0n : byteSeconds).toString(),
    workflow_exec_vcpu_second: usage.vcpuSeconds.toFixed(9),
    workflow_exec_gib_second: usage.gibSeconds.toFixed(9),
  }
}
