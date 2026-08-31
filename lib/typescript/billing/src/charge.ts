import { createHash } from "node:crypto"
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { lockAvailableBalance, postWithin } from "./ledger"
import { groupedOverhead, type MicroUsd, rateTimesQuantity } from "./money"
import { displayForDimension } from "./dimensions"
import { addQuantities, paidQuantity, recordUsageStatement } from "./statements"
import { NoActivePriceBookError, RETIRED_UNBILLABLE_DIMENSIONS } from "./usage"

/**
 * Turn measured usage into money the customer actually owes.
 *
 * ## The missing link
 *
 * The money path originally stopped at read-time rating: raw usage became `usage_rollup`, and
 * `rateProjectsForOrganization` multiplied quantity by rate so a dashboard could show a cost.
 * Nothing posted a ledger entry. `usage_rollup.rated_transaction_id` — the column whose whole
 * purpose is to record which transaction charged a grain — had no writer anywhere in the
 * repository, and every organization's balance stayed at its top-up despite consumed compute.
 *
 * Read-time rating is right for *display*, and the note on `rateProjectsForOrganization` says why:
 * a stored cost is wrong the moment a rate changes. It is not a charge. A prepaid platform whose
 * balances never fall is a platform giving compute away.
 *
 * ## Charging exactly one grain
 *
 * The ClickHouse importer writes the same usage at minute, hour **and** day grain. Summing across
 * buckets charges everything three times, and nothing about the result looks wrong — the
 * arithmetic is consistent, the ledger balances, and the customer is billed triple.
 *
 * This charges the **hour** grain and nothing else, and `assertSingleGrain` makes that structural
 * rather than a matter of remembering. Hour rather than day because a prepaid balance that only
 * moves once a day cannot stop work that has already run out of credit; hour rather than minute
 * because sixty times the transactions buys nothing.
 *
 * A consequence worth stating plainly: `rated_transaction_id` is meaningful **only on hour rows**.
 * The minute and day rows are other views of the same events and stay null forever. That reads like
 * "never charged" to anyone who does not know, so it is written here rather than left to be
 * rediscovered from a confusing query.
 *
 * ## Prepaid means the balance is a hard floor
 *
 * Metering arrives after the resource was used, so a delayed sample can cost more than the credit
 * remaining when it is rated. That operational lag is the platform's risk, not a customer debt.
 * The charger takes at most the locked available balance, marks the sample settled, and never lets
 * a later top-up pay for old overage. Holds still prevent the expensive paths from starting without
 * credit; this is the last-line invariant for every asynchronous meter.
 */

/** The grain that gets charged. See the note above. */
export const CHARGED_BUCKET = "hour"

/** How many rollup rows one run claims. */
export const CHARGE_BATCH_SIZE = 2000

/** Cap one delayed charge without letting non-storage work consume the retention floor. */
export function protectedUsageDebit(
  available: MicroUsd,
  total: MicroUsd,
  storageUsage: MicroUsd,
  protectedReserve: MicroUsd,
): MicroUsd {
  if (available <= 0n || total <= 0n) return 0n
  const unreserved = available > protectedReserve ? available - protectedReserve : 0n
  const payable = unreserved + storageUsage
  return total < available
    ? total < payable
      ? total
      : payable
    : available < payable
      ? available
      : payable
}

/**
 * A short, stable key for one charge.
 *
 * SHA-256 of the sorted `id=quantity` pairs, truncated. Sorted because `skip locked` makes the
 * claim order nondeterministic and the same work must produce the same key; truncated because
 * `idempotency_key` is one column and an organization with two thousand grains would otherwise
 * produce a key tens of kilobytes long.
 */
export function chargeKey(watermark: readonly string[]): string {
  return createHash("sha256").update(watermark.slice().sort().join("\n")).digest("hex").slice(0, 32)
}

export type ChargeResult = {
  /** Organizations charged. */
  organizations: number
  /** Rollup rows stamped. */
  rollups: number
  /** Total posted, overhead included. */
  chargedMicroUsd: MicroUsd
}

/**
 * Guard against ever summing more than one grain.
 *
 * Called with the rows about to be charged. A row of any other bucket in the set means a query
 * changed somewhere and the customer is about to be billed two or three times for the same
 * seconds — the one bug in this file that produces no error of its own.
 */
export function assertSingleGrain(buckets: readonly string[]): void {
  const distinct = [...new Set(buckets)]
  if (distinct.length > 1 || (distinct[0] !== undefined && distinct[0] !== CHARGED_BUCKET)) {
    throw new MultipleGrainsError(distinct)
  }
}

export class MultipleGrainsError extends Error {
  override readonly name = "MultipleGrainsError"

  constructor(buckets: string[]) {
    super(
      `Refusing to charge buckets [${buckets.join(", ")}]. The same usage is rolled up at ` +
        `minute, hour and day, so charging more than "${CHARGED_BUCKET}" bills it more than once.`,
    )
  }
}

/**
 * Charge every organization for its unbilled hours.
 *
 * `now` is a parameter so a test can place the boundary. The importer supplies closed grains; this
 * query still refuses a bucket whose start is not earlier than the charge clock.
 */
export async function chargeUsage(
  db: Kysely<DB>,
  options: { now?: Date; batchSize?: number } = {},
): Promise<ChargeResult> {
  const now = options.now ?? new Date()
  const batchSize = options.batchSize ?? CHARGE_BATCH_SIZE

  const book = await db
    .selectFrom("priceBook")
    .select(["id", "overheadBps"])
    .where("effectiveAt", "<=", now)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  // Charging nothing because no book is in force would be a free platform with a green job. The
  // same refusal `rateProjectsForOrganization` makes, for the same reason.
  if (book === undefined) throw new NoActivePriceBookError()

  return await db.transaction().execute(async (trx) => {
    /*
      `FOR UPDATE SKIP LOCKED`, and the stamp happens in this same transaction.

      Two workers overlap during a rolling deploy. Without the lock both would select the same
      rollups, both would post, and the customer would be charged twice with nothing anywhere
      reporting a problem.
    */
    const claimed = await sql<{
      id: string
      organizationId: string
      projectId: string | null
      dimension: string
      bucket: string
      /** What has not been charged yet, not the grain's whole quantity. */
      uncharged: string
      quantity: string
    }>`
      select
        id,
        organization_id as "organizationId",
        project_id as "projectId",
        dimension,
        bucket,
        (quantity - charged_quantity)::text as uncharged,
        quantity::text as quantity
      from usage_rollup
      where quantity > charged_quantity
        and bucket = ${CHARGED_BUCKET}
        and bucket_start < ${now}
        and dimension <> all(${RETIRED_UNBILLABLE_DIMENSIONS})
      order by bucket_start
      limit ${batchSize}
      for update skip locked
    `.execute(trx)

    if (claimed.rows.length === 0) {
      return { organizations: 0, rollups: 0, chargedMicroUsd: 0n }
    }

    assertSingleGrain(claimed.rows.map((row) => row.bucket))

    const rates = new Map(
      (
        await trx
          .selectFrom("priceBookItem")
          .select(["dimension", "unitMicroUsd", "overheadBps"])
          .where("priceBookId", "=", book.id)
          .where("dimension", "in", [...new Set(claimed.rows.map((row) => row.dimension))])
          .execute()
      ).map((item) => [item.dimension, item]),
    )

    /** Per organization: what it owes, which rows that covers, and the state that charge leaves. */
    type OwedEntry = {
      usage: MicroUsd
      byDimension: Map<string, { usage: MicroUsd; overheadBps: number | null }>
      lines: Map<
        string,
        {
          projectId: string | null
          dimension: string
          quantity: string
          unitMicroUsd: string
          ratedMicroUsd: MicroUsd
        }
      >
      ids: string[]
      watermark: string[]
    }
    const owed = new Map<string, OwedEntry>()

    for (const row of claimed.rows) {
      const item = rates.get(row.dimension)
      // A dimension the book does not price is a seeding bug, not a free dimension. Skipping it
      // quietly is how a customer's bill loses a line and nobody finds out.
      if (item === undefined) throw new NoActivePriceBookError()

      /*
        The *uncharged* part of the grain, not its whole quantity.

        The importer can replace a grain with a larger absolute total after late usage arrives —
        the metering agent has a retry buffer, so delay from a restart or partition is ordinary.
        Charging `quantity` again would bill the paid part twice; skipping the row, which is what a
        null-marker check did, made the addition free.
      */
      const entry: OwedEntry = owed.get(row.organizationId) ?? {
        usage: 0n,
        byDimension: new Map<string, { usage: MicroUsd; overheadBps: number | null }>(),
        lines: new Map(),
        ids: [] as string[],
        watermark: [] as string[],
      }
      const amount = rateTimesQuantity(item.unitMicroUsd, row.uncharged)
      entry.usage += amount
      const dimension = entry.byDimension.get(row.dimension) ?? {
        usage: 0n,
        overheadBps: item.overheadBps,
      }
      dimension.usage += amount
      entry.byDimension.set(row.dimension, dimension)
      const lineKey = `${row.projectId ?? ""}\u0000${row.dimension}`
      const line = entry.lines.get(lineKey) ?? {
        projectId: row.projectId,
        dimension: row.dimension,
        quantity: "0",
        unitMicroUsd: item.unitMicroUsd,
        ratedMicroUsd: 0n,
      }
      line.quantity = addQuantities(line.quantity, row.uncharged)
      line.ratedMicroUsd += amount
      entry.lines.set(lineKey, line)
      entry.ids.push(row.id)
      // Where each row's `charged_quantity` will stand once this charge commits. Part of the
      // idempotency key — see below.
      entry.watermark.push(`${row.id}=${row.quantity}`)
      owed.set(row.organizationId, entry)
    }

    let organizations = 0
    let rollups = 0
    let charged = 0n

    for (const [organizationId, entry] of owed) {
      const fee = groupedOverhead(
        [...entry.byDimension.values()].map((dimension) => ({
          usageCost: dimension.usage,
          overheadBps: dimension.overheadBps,
        })),
        book.overheadBps,
      )
      const total = entry.usage + fee

      /*
        Lock before deciding how much can be posted. Usage may cost more than what remains, and two
        charge workers must not each spend the same last dollar. Any unpaid tail is settled without
        a transaction: prepaid usage is not debt waiting to eat the next top-up.
      */
      const available = await lockAvailableBalance(trx, organizationId)
      const retained = await trx
        .selectFrom("creditRetentionState")
        .select("reserveMicroUsd")
        .where("organizationId", "=", organizationId)
        .executeTakeFirst()
      const protectedReserve = BigInt(retained?.reserveMicroUsd ?? 0)
      const storageUsage = entry.byDimension.get("object_storage_gb_month")?.usage ?? 0n
      /*
        Ordinary delayed usage may spend only the balance above the two-day storage floor.

        Storage residency itself may consume the floor as those retained hours actually pass. The
        sum below is therefore "unreserved balance plus storage due in this batch", capped by the
        real balance and the amount owed. Without this, a late AI or compute grain could drain the
        money set aside to keep data during the advertised reprieve.
      */
      const debit = protectedUsageDebit(available, total, storageUsage, protectedReserve)
      const paidUsage = debit < entry.usage ? debit : entry.usage
      const paidOverhead = debit - paidUsage
      const idempotencyKey = `usage:${organizationId}:${chargeKey(entry.watermark)}`
      const posted =
        debit === 0n
          ? null
          : await postWithin(trx, {
              organizationId,
              kind: "usage",
              /*
                Keyed on the rows **and the quantity they will stand at**. The row ids alone do not
                distinguish late usage added to a grain that was already charged.
              */
              idempotencyKey,
              description:
                debit === total
                  ? `Metered usage, ${entry.ids.length} grain(s)`
                  : `Metered usage capped at prepaid balance, ${entry.ids.length} grain(s)`,
              postings: [
                { account: "user_credit", amount: -debit },
                // Usage first, then overhead. If only part of a delayed sample can be paid, the
                // platform does not take a fee while forgiving the underlying resource cost.
                { account: "platform_revenue", amount: paidUsage },
                { account: "platform_revenue", amount: paidOverhead },
              ],
            })
      /*
        Only what was actually posted.

        `postWithin` returns the existing transaction when the key matches, and writes nothing.
        Adding `total` regardless made the job report money it had not charged — which is exactly
        how the idempotency-key bug below looked from the outside: a charge of the right size,
        reported, with the balance unmoved.
      */
      if (posted?.created === true) charged += debit

      if (posted?.created === true) {
        let usageRemaining = paidUsage
        const usageLines = [...entry.lines.values()]
          .toSorted((left, right) =>
            left.dimension === "object_storage_gb_month" &&
            right.dimension !== "object_storage_gb_month"
              ? -1
              : right.dimension === "object_storage_gb_month" &&
                  left.dimension !== "object_storage_gb_month"
                ? 1
                : `${left.projectId ?? ""}:${left.dimension}`.localeCompare(
                    `${right.projectId ?? ""}:${right.dimension}`,
                  ),
          )
          .flatMap((line) => {
            const allocated =
              usageRemaining < line.ratedMicroUsd ? usageRemaining : line.ratedMicroUsd
            usageRemaining -= allocated
            if (allocated <= 0n) return []
            const display = displayForDimension(line.dimension)
            return [
              {
                projectId: line.projectId,
                dimension: line.dimension,
                quantity: paidQuantity(line.quantity, allocated, line.ratedMicroUsd),
                unitMicroUsd: line.unitMicroUsd,
                amountMicroUsd: allocated,
                description: display.label,
              },
            ]
          })
        if (usageRemaining !== 0n) {
          throw new Error(
            `Statement allocation left ${usageRemaining.toString()} micro-USD unexplained`,
          )
        }
        await recordUsageStatement(trx, {
          organizationId,
          creditTransactionId: posted.transactionId,
          chargedAt: now,
          overheadBps: book.overheadBps,
          usageLines,
          overheadMicroUsd: paidOverhead,
        })
      }

      /*
        `charged_quantity = quantity`, in the same transaction as the posting.

        Reading the column rather than a value carried from the select, so a concurrent upsert that
        landed between the claim and here is accounted for rather than silently marked paid — the
        row lock makes that impossible today, and depending on the lock for a correctness property
        the SQL can state itself is how it stops being true later.

        `rated_transaction_id` becomes "the transaction that last charged this grain" rather than
        "this grain has been charged". The difference matters the moment usage arrives late.
      */
      await sql`
        update usage_rollup
        set charged_quantity = quantity,
            rated_transaction_id = coalesce(${posted?.transactionId ?? null}, rated_transaction_id),
            updated_at = ${now}
        where id = any(${entry.ids}::uuid[])
      `.execute(trx)

      organizations += 1
      rollups += entry.ids.length
    }

    return { organizations, rollups, chargedMicroUsd: charged }
  })
}
