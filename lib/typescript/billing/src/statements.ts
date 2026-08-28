import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { v7 } from "uuid"
import type { MicroUsd } from "./money"

const LEGACY_BATCH_SIZE = 500
const DECIMAL_SCALE = 1_000_000_000n

export type UsageStatementLine = {
  projectId: string | null
  dimension: string
  quantity: string
  unitMicroUsd: string
  amountMicroUsd: MicroUsd
  description: string
}

export type StatementRunResult = {
  importedTransactions: number
  createdStatements: number
  finalizedStatements: number
}

export function statementPeriod(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return { start, end }
}

function parseDecimal(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".")
  return BigInt(whole) * DECIMAL_SCALE + BigInt((fraction + "0".repeat(9)).slice(0, 9))
}

function decimal(value: bigint): string {
  const whole = value / DECIMAL_SCALE
  const fraction = (value % DECIMAL_SCALE).toString().padStart(9, "0").replace(/0+$/, "")
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`
}

export function addQuantities(left: string, right: string): string {
  return decimal(parseDecimal(left) + parseDecimal(right))
}

/** Keep a partial prepaid charge's displayed quantity proportional to the amount actually paid. */
export function paidQuantity(quantity: string, paid: MicroUsd, rated: MicroUsd): string {
  if (paid <= 0n || rated <= 0n) return "0"
  if (paid >= rated) return quantity
  return decimal((parseDecimal(quantity) * paid) / rated)
}

async function lockedStatement(
  tx: Transaction<DB>,
  organizationId: string,
  at: Date,
  overheadBps: number,
  requireDraft = true,
): Promise<{ id: string; created: boolean }> {
  const period = statementPeriod(at)
  const candidateId = v7()
  const inserted = await tx
    .insertInto("statement")
    .values({
      id: candidateId,
      organizationId,
      periodStart: period.start,
      periodEnd: period.end,
      overheadBps,
    })
    .onConflict((oc) => oc.columns(["organizationId", "periodStart"]).doNothing())
    .returning("id")
    .executeTakeFirst()

  const statement = await tx
    .selectFrom("statement")
    .select(["id", "status"])
    .where("organizationId", "=", organizationId)
    .where("periodStart", "=", period.start)
    .forUpdate()
    .executeTakeFirstOrThrow()

  if (requireDraft && statement.status !== "draft") {
    throw new Error(
      `Refusing to add ledger activity to ${statement.status} statement ${statement.id}`,
    )
  }
  return { id: statement.id, created: inserted?.id === candidateId }
}

async function associateCharge(
  tx: Transaction<DB>,
  statementId: string,
  creditTransactionId: string,
): Promise<boolean> {
  const row = await tx
    .insertInto("statementCharge")
    .values({ id: v7(), statementId, creditTransactionId })
    .onConflict((oc) => oc.column("creditTransactionId").doNothing())
    .returning("id")
    .executeTakeFirst()
  return row !== undefined
}

async function addLine(
  tx: Transaction<DB>,
  input: {
    statementId: string
    projectId: string | null
    kind: "usage" | "overhead"
    dimension: string | null
    quantity: string
    unitMicroUsd: string | null
    amountMicroUsd: MicroUsd
    description: string
  },
): Promise<void> {
  if (input.amountMicroUsd <= 0n) return
  await tx
    .insertInto("statementLineItem")
    .values({ id: v7(), ...input })
    .onConflict((oc) =>
      oc.columns(["statementId", "kind", "projectId", "dimension"]).doUpdateSet({
        quantity: sql`statement_line_item.quantity + excluded.quantity`,
        amountMicroUsd: sql`statement_line_item.amount_micro_usd + excluded.amount_micro_usd`,
        unitMicroUsd: sql`
          case
            when statement_line_item.unit_micro_usd = excluded.unit_micro_usd
              then statement_line_item.unit_micro_usd
            else null
          end
        `,
      }),
    )
    .execute()
}

async function refreshTotals(tx: Transaction<DB>, statementId: string, at: Date): Promise<void> {
  await sql`
    update statement
    set subtotal_micro_usd = coalesce((
          select sum(amount_micro_usd) from statement_line_item
          where statement_id = ${statementId} and kind = 'usage'
        ), 0),
        overhead_micro_usd = coalesce((
          select sum(amount_micro_usd) from statement_line_item
          where statement_id = ${statementId} and kind = 'overhead'
        ), 0),
        total_micro_usd = coalesce((
          select sum(amount_micro_usd) from statement_line_item
          where statement_id = ${statementId}
        ), 0),
        updated_at = ${at}
    where id = ${statementId}
  `.execute(tx)
}

/**
 * Attach one newly-created usage debit to the current draft statement.
 *
 * Called inside the same transaction that posts the ledger debit. Either the ledger and its
 * customer explanation both commit, or neither does.
 */
export async function recordUsageStatement(
  tx: Transaction<DB>,
  input: {
    organizationId: string
    creditTransactionId: string
    chargedAt: Date
    overheadBps: number
    usageLines: UsageStatementLine[]
    overheadMicroUsd: MicroUsd
  },
): Promise<void> {
  const statement = await lockedStatement(
    tx,
    input.organizationId,
    input.chargedAt,
    input.overheadBps,
  )
  if (!(await associateCharge(tx, statement.id, input.creditTransactionId))) return

  for (const line of input.usageLines) {
    await addLine(tx, {
      statementId: statement.id,
      projectId: line.projectId,
      kind: "usage",
      dimension: line.dimension,
      quantity: line.quantity,
      unitMicroUsd: line.unitMicroUsd,
      amountMicroUsd: line.amountMicroUsd,
      description: line.description,
    })
  }
  await addLine(tx, {
    statementId: statement.id,
    projectId: null,
    kind: "overhead",
    dimension: null,
    quantity: "1",
    unitMicroUsd: null,
    amountMicroUsd: input.overheadMicroUsd,
    description: "Platform fee",
  })
  await refreshTotals(tx, statement.id, input.chargedAt)
}

/**
 * Reconcile historical ledger debits, create the just-closed month's zero statement where needed,
 * and finalize closed periods.
 *
 * The ledger is authoritative. Old usage transactions predate statement attribution, so they are
 * represented as exact generic usage and fee lines rather than an invented project/dimension
 * split. New charges arrive through `recordUsageStatement` with full attribution.
 */
export async function generateMonthlyStatements(
  db: Kysely<DB>,
  now: Date = new Date(),
  options: { organizationIds?: string[] } = {},
): Promise<StatementRunResult> {
  return await db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('sproutos:billing:statements'))`.execute(tx)

    const legacy = await tx
      .selectFrom("creditTransaction")
      .select(["id", "organizationId", "description", "createdAt"])
      .where("kind", "=", "usage")
      .$if(options.organizationIds !== undefined, (query) =>
        query.where("organizationId", "in", options.organizationIds!),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("statementCharge")
              .select("statementCharge.id")
              .whereRef("statementCharge.creditTransactionId", "=", "creditTransaction.id"),
          ),
        ),
      )
      .orderBy("createdAt", "asc")
      .limit(LEGACY_BATCH_SIZE)
      .execute()

    const entryRows =
      legacy.length === 0
        ? []
        : await tx
            .selectFrom("creditLedgerEntry")
            .innerJoin("creditAccount", "creditAccount.id", "creditLedgerEntry.creditAccountId")
            .select([
              "creditLedgerEntry.creditTransactionId",
              "creditLedgerEntry.amountMicroUsd",
              "creditLedgerEntry.seq",
              "creditAccount.kind",
            ])
            .where(
              "creditLedgerEntry.creditTransactionId",
              "in",
              legacy.map((row) => row.id),
            )
            .orderBy("creditLedgerEntry.seq", "asc")
            .execute()

    const byTransaction = new Map<string, typeof entryRows>()
    for (const entry of entryRows) {
      const entries = byTransaction.get(entry.creditTransactionId) ?? []
      entries.push(entry)
      byTransaction.set(entry.creditTransactionId, entries)
    }

    let importedTransactions = 0
    let createdStatements = 0
    for (const transaction of legacy) {
      const entries = byTransaction.get(transaction.id) ?? []
      const debit = entries
        .map((entry) => ({ ...entry, amountMicroUsd: BigInt(entry.amountMicroUsd) }))
        .filter((entry) => entry.kind === "user_credit" && entry.amountMicroUsd < 0n)
        .reduce((sum, entry) => sum - entry.amountMicroUsd, 0n)
      const revenue = entries
        .map((entry) => ({ ...entry, amountMicroUsd: BigInt(entry.amountMicroUsd) }))
        .filter((entry) => entry.kind === "platform_revenue" && entry.amountMicroUsd >= 0n)
        .map((entry) => entry.amountMicroUsd)
      const usage = revenue[0] ?? 0n
      const overhead = revenue.slice(1).reduce((sum, amount) => sum + amount, 0n)
      if (usage + overhead !== debit) {
        throw new Error(
          `Usage transaction ${transaction.id} cannot be reconciled: debit ${debit.toString()}, revenue ${(usage + overhead).toString()}`,
        )
      }

      const statement = await lockedStatement(
        tx,
        transaction.organizationId,
        transaction.createdAt,
        0,
      )
      if (statement.created) createdStatements += 1
      if (!(await associateCharge(tx, statement.id, transaction.id))) continue
      importedTransactions += 1
      await addLine(tx, {
        statementId: statement.id,
        projectId: null,
        kind: "usage",
        dimension: null,
        quantity: "1",
        unitMicroUsd: null,
        amountMicroUsd: usage,
        description: transaction.description ?? "Metered usage",
      })
      await addLine(tx, {
        statementId: statement.id,
        projectId: null,
        kind: "overhead",
        dimension: null,
        quantity: "1",
        unitMicroUsd: null,
        amountMicroUsd: overhead,
        description: "Platform fee",
      })
      await refreshTotals(tx, statement.id, now)
    }

    const current = statementPeriod(now)
    const previousStart = new Date(
      Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1),
    )
    const organizations = await tx
      .selectFrom("organization")
      .select("id")
      .where("deletedAt", "is", null)
      .$if(options.organizationIds !== undefined, (query) =>
        query.where("id", "in", options.organizationIds!),
      )
      .execute()
    for (const organization of organizations) {
      const statement = await lockedStatement(tx, organization.id, previousStart, 0, false)
      if (statement.created) createdStatements += 1
    }

    const finalizable = await tx
      .selectFrom("statement")
      .select("id")
      .where("status", "=", "draft")
      .where("periodEnd", "<=", now)
      .$if(options.organizationIds !== undefined, (query) =>
        query.where("organizationId", "in", options.organizationIds!),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("creditTransaction")
              .select("creditTransaction.id")
              .whereRef("creditTransaction.organizationId", "=", "statement.organizationId")
              .where("creditTransaction.kind", "=", "usage")
              .whereRef("creditTransaction.createdAt", ">=", "statement.periodStart")
              .whereRef("creditTransaction.createdAt", "<", "statement.periodEnd")
              .where((innerEb) =>
                innerEb.not(
                  innerEb.exists(
                    innerEb
                      .selectFrom("statementCharge")
                      .select("statementCharge.id")
                      .whereRef("statementCharge.creditTransactionId", "=", "creditTransaction.id"),
                  ),
                ),
              ),
          ),
        ),
      )
      .execute()

    if (finalizable.length > 0) {
      await tx
        .updateTable("statement")
        .set({ status: "finalized", finalizedAt: now, updatedAt: now })
        .where(
          "id",
          "in",
          finalizable.map((row) => row.id),
        )
        .execute()
    }

    return {
      importedTransactions,
      createdStatements,
      finalizedStatements: finalizable.length,
    }
  })
}
