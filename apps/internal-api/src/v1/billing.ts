import { balances, BelowMinimumTopupError, begin, MINIMUM_TOPUP, quote, stripe } from "@lib/billing"
import { overhead, rateTimesQuantity } from "@lib/billing/money"
import { startOfMonth } from "@lib/billing/usage"
import { crudAuditLog } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { requirePermission } from "../rbac"
import { authMiddleware } from "../middleware"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwConflict } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  billingSchemaAutoReloadRequest,
  billingSchemaAutoReloadResponse,
  billingSchemaBalanceResponse,
  billingSchemaQuoteQuery,
  billingSchemaQuoteResponse,
  billingSchemaTopupRequest,
  billingSchemaTopupResponse,
  billingSchemaTransactionsQuery,
  billingSchemaStatementsResponse,
  billingSchemaTransactionsResponse,
  billingSchemaUsageResponse,
} from "./billing.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

function parseMicroUsd(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/balance",
    describeRoute({
      description: "Reads the organization's spendable credit balance",
      responses: {
        200: {
          description: "Current balance",
          content: { "application/json": { schema: resolver(billingSchemaBalanceResponse) } },
        },
        403: { description: "Caller may not read billing", ...errorResponse },
        404: { description: "Organization not found", ...errorResponse },
      },
    }),
    requirePermission("billing:read"),
    async (c) => {
      const organization = c.var.organization

      // Both figures come from one read. Calling availableBalance twice returned the same
      // number — it already subtracts holds — so the held figure was always zero.
      const { posted, held, available } = await balances(db, organization.id)

      return c.json({
        balanceMicroUsd: posted.toString(),
        heldMicroUsd: held.toString(),
        availableMicroUsd: available.toString(),
        currency: "USD",
      })
    },
  )
  .get(
    "/topup/quote",
    describeRoute({
      description: "Quotes the processing fee and resulting credit for a top-up amount",
      responses: {
        200: {
          description: "Top-up quote",
          content: { "application/json": { schema: resolver(billingSchemaQuoteResponse) } },
        },
        400: { description: "Amount is below the minimum or malformed", ...errorResponse },
        403: { description: "Caller may not read billing", ...errorResponse },
      },
    }),
    requirePermission("billing:read"),
    validator("query", billingSchemaQuoteQuery),
    (c) => {
      const query = c.req.valid("query")
      const amount = parseMicroUsd(query.amountMicroUsd)
      if (amount === null) return throwBadRequest(c, "amountMicroUsd is not an integer")

      if (amount < MINIMUM_TOPUP) {
        return throwBadRequest(
          c,
          `Top-ups must be at least ${MINIMUM_TOPUP.toString()} micro-USD`,
          ErrorCode.ValidationFailed,
          { target: "amountMicroUsd" },
        )
      }

      const q = quote(amount)
      return c.json({
        chargeMicroUsd: q.chargeMicroUsd.toString(),
        feeMicroUsd: q.feeMicroUsd.toString(),
        creditMicroUsd: q.creditMicroUsd.toString(),
        minimumMicroUsd: MINIMUM_TOPUP.toString(),
      })
    },
  )
  .post(
    "/topup",
    describeRoute({
      description: "Starts a credit top-up and returns a Stripe client secret",
      responses: {
        201: {
          description: "Top-up started",
          content: { "application/json": { schema: resolver(billingSchemaTopupResponse) } },
        },
        400: { description: "Amount is below the minimum or malformed", ...errorResponse },
        403: {
          description: "Caller may not spend on behalf of the organization",
          ...errorResponse,
        },
        502: { description: "Stripe rejected the request", ...errorResponse },
      },
    }),
    requirePermission("billing:write"),
    validator("json", billingSchemaTopupRequest),
    async (c) => {
      const organization = c.var.organization
      const json = c.req.valid("json")

      const amount = parseMicroUsd(json.amountMicroUsd)
      if (amount === null) return throwBadRequest(c, "amountMicroUsd is not an integer")

      const customerId = await ensureStripeCustomer(organization.id, organization.name)

      try {
        const result = await begin(db, {
          organizationId: organization.id,
          amountMicroUsd: amount,
          initiatedBy: "user",
          stripeCustomerId: customerId,
        })

        await crudAuditLog(db).record({
          organizationId: organization.id,
          actorUserId: c.var.user.id,
          action: "billing:write",
          resourceSrn: `topup/${result.topupId}`,
          after: {
            chargeMicroUsd: result.quote.chargeMicroUsd.toString(),
            feeMicroUsd: result.quote.feeMicroUsd.toString(),
          },
          ...auditContext(c),
        })

        return c.json(
          {
            topupId: result.topupId,
            clientSecret: result.clientSecret,
            chargeMicroUsd: result.quote.chargeMicroUsd.toString(),
            feeMicroUsd: result.quote.feeMicroUsd.toString(),
            creditMicroUsd: result.quote.creditMicroUsd.toString(),
          },
          201,
        )
      } catch (error) {
        if (error instanceof BelowMinimumTopupError) {
          return throwBadRequest(
            c,
            `Top-ups must be at least ${MINIMUM_TOPUP.toString()} micro-USD`,
            ErrorCode.ValidationFailed,
            { target: "amountMicroUsd" },
          )
        }
        throw error
      }
    },
  )
  .get(
    "/transactions",
    describeRoute({
      description: "Lists the organization's credit transactions, newest first",
      responses: {
        200: {
          description: "Credit transactions",
          content: { "application/json": { schema: resolver(billingSchemaTransactionsResponse) } },
        },
        403: { description: "Caller may not read billing", ...errorResponse },
      },
    }),
    requirePermission("billing:read"),
    validator("query", billingSchemaTransactionsQuery),
    async (c) => {
      const organization = c.var.organization
      const query = c.req.valid("query")
      const limit = query.limit ?? 50

      const rows = await db
        .selectFrom("creditTransaction")
        .innerJoin(
          "creditLedgerEntry",
          "creditLedgerEntry.creditTransactionId",
          "creditTransaction.id",
        )
        .innerJoin("creditAccount", "creditAccount.id", "creditLedgerEntry.creditAccountId")
        .select([
          "creditTransaction.id",
          "creditTransaction.kind",
          "creditTransaction.description",
          "creditTransaction.createdAt",
          "creditLedgerEntry.amountMicroUsd",
        ])
        .where("creditTransaction.organizationId", "=", organization.id)
        .where("creditAccount.kind", "=", "user_credit")
        .orderBy("creditTransaction.createdAt", "desc")
        .limit(limit + 1)
        .execute()

      const page = rows.slice(0, limit)
      return c.json({
        data: page.map((r) => ({
          id: r.id,
          kind: r.kind,
          description: r.description,
          amountMicroUsd: r.amountMicroUsd,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      })
    },
  )
  .put(
    "/auto-reload",
    describeRoute({
      description: "Configures automatic top-ups when the balance falls below a threshold",
      responses: {
        200: {
          description: "Auto-reload settings",
          content: { "application/json": { schema: resolver(billingSchemaAutoReloadResponse) } },
        },
        400: { description: "Threshold or amount is malformed", ...errorResponse },
        403: { description: "Caller may not change billing", ...errorResponse },
      },
    }),
    requirePermission("billing:write"),
    validator("json", billingSchemaAutoReloadRequest),
    async (c) => {
      const organization = c.var.organization
      const json = c.req.valid("json")

      const threshold = json.thresholdMicroUsd ? parseMicroUsd(json.thresholdMicroUsd) : null
      const amount = json.amountMicroUsd ? parseMicroUsd(json.amountMicroUsd) : null

      if (json.enabled && (threshold === null || amount === null)) {
        return throwBadRequest(
          c,
          "Enabling auto-reload requires a threshold and an amount",
          ErrorCode.ValidationFailed,
        )
      }
      if (amount !== null && amount < MINIMUM_TOPUP) {
        return throwBadRequest(
          c,
          `Auto-reload amount must be at least ${MINIMUM_TOPUP.toString()} micro-USD`,
          ErrorCode.ValidationFailed,
          { target: "amountMicroUsd" },
        )
      }

      const customerId = await ensureStripeCustomer(organization.id, organization.name)

      // The threshold and amount columns are NOT NULL with defaults, and turning
      // auto-reload off should not discard the numbers the user chose — flipping
      // it back on would otherwise silently revert to the platform default.
      await db
        .updateTable("stripeCustomer")
        .set({
          autoReloadEnabled: json.enabled,
          ...(threshold === null ? {} : { autoReloadThresholdMicroUsd: threshold }),
          ...(amount === null ? {} : { autoReloadAmountMicroUsd: amount }),
          updatedAt: new Date(),
        })
        .where("stripeCustomerId", "=", customerId)
        .execute()

      const saved = await db
        .selectFrom("stripeCustomer")
        .select(["autoReloadEnabled", "autoReloadThresholdMicroUsd", "autoReloadAmountMicroUsd"])
        .where("stripeCustomerId", "=", customerId)
        .executeTakeFirstOrThrow()

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "billing:write",
        resourceSrn: "billing/auto-reload",
        after: { enabled: json.enabled },
        ...auditContext(c),
      })

      return c.json({
        enabled: saved.autoReloadEnabled,
        thresholdMicroUsd: saved.autoReloadThresholdMicroUsd,
        amountMicroUsd: saved.autoReloadAmountMicroUsd,
      })
    },
  )

/**
 * Find or create the organization's Stripe customer.
 *
 * Created lazily on first billing interaction rather than at signup, so an
 * organization that never pays leaves nothing behind in Stripe.
 */
async function ensureStripeCustomer(organizationId: string, name: string): Promise<string> {
  const existing = await db
    .selectFrom("stripeCustomer")
    .select("stripeCustomerId")
    .where("organizationId", "=", organizationId)
    .executeTakeFirst()

  if (existing) return existing.stripeCustomerId

  const customer = await stripe().customers.create(
    { name, metadata: { organization_id: organizationId } },
    // Deduplicates on Stripe's side, so a retry after a crash between the API
    // call and the insert reuses the customer instead of orphaning one.
    { idempotencyKey: `org:${organizationId}` },
  )

  await db
    .insertInto("stripeCustomer")
    .values({ id: v7(), organizationId, stripeCustomerId: customer.id })
    .onConflict((oc) => oc.column("organizationId").doNothing())
    .execute()

  const row = await db
    .selectFrom("stripeCustomer")
    .select("stripeCustomerId")
    .where("organizationId", "=", organizationId)
    .executeTakeFirstOrThrow()

  return row.stripeCustomerId
}

/**
 * How each metered dimension is named and counted for a person.
 *
 * The database's dimension names are units of measurement — `site_vcpu_second`, `db_storage_gib_hour`
 * — which is right for a meter and wrong for a bill. Nobody reconciles an invoice against
 * "valkey_queue_byte_second".
 *
 * `divisor` converts the stored quantity into the unit shown. Storage is metered per GiB-*hour* and
 * read per GiB-*month*, which is a factor of 730 and the single easiest place to be wrong by three
 * orders of magnitude.
 */
const DIMENSION_DISPLAY: Record<string, { label: string; unit: string; divisor: number }> = {
  site_vcpu_second: { label: "Compute", unit: "vCPU-hours", divisor: 3600 },
  site_gib_second: { label: "Memory", unit: "GiB-hours", divisor: 3600 },
  site_active_cpu_second: { label: "Active CPU", unit: "vCPU-hours", divisor: 3600 },
  site_provisioned_gib_second: { label: "Provisioned memory", unit: "GiB-hours", divisor: 3600 },
  site_request: { label: "Requests", unit: "requests", divisor: 1 },
  site_egress_byte: { label: "Egress", unit: "GB", divisor: 1_000_000_000 },
  site_ws_connection_second: { label: "WebSocket time", unit: "connection-hours", divisor: 3600 },
  db_storage_gib_hour: { label: "Postgres storage", unit: "GiB-months", divisor: 730 },
  db_compute_cu_second: { label: "Postgres compute", unit: "CU-hours", divisor: 3600 },
  es_storage_gib_hour: { label: "Search storage", unit: "GiB-months", divisor: 730 },
  es_search_unit: { label: "Search queries", unit: "queries", divisor: 1 },
  valkey_queue_byte_second: {
    label: "Queue residency",
    unit: "GiB-hours",
    divisor: 3_865_470_566_400,
  },
  workflow_job_enqueued: { label: "Workflow jobs", unit: "jobs", divisor: 1 },
  workflow_exec_vcpu_second: { label: "Workflow compute", unit: "vCPU-hours", divisor: 3600 },
  workflow_exec_gib_second: { label: "Workflow memory", unit: "GiB-hours", divisor: 3600 },
  ai_input_token: { label: "AI input", unit: "tokens", divisor: 1 },
  ai_output_token: { label: "AI output", unit: "tokens", divisor: 1 },
  ai_cache_read_token: { label: "AI cache reads", unit: "tokens", divisor: 1 },
  agent_run_second: { label: "Agent time", unit: "hours", divisor: 3600 },
}

/**
 * A quantity in the unit a person reads.
 *
 * Kept as a decimal string end to end. `numeric(38,9)` does not fit a JavaScript number at either
 * end of its range — byte-seconds run past 2^53 within a day, and a token rate is a fraction of a
 * micro-USD — and this is the figure a customer checks an invoice against.
 */
function displayQuantity(raw: string, divisor: number): string {
  if (divisor === 1) return trimZeros(raw)
  // Scaled in fixed point rather than by dividing floats: `1e11 / 3600` in double precision is
  // already approximate, and an invoice line that does not add up is a support ticket.
  const scaled = (BigInt(Math.round(Number(raw) * 1e6)) * 1_000_000n) / BigInt(divisor)
  const whole = scaled / 1_000_000_000_000n
  const fraction = (scaled % 1_000_000_000_000n).toString().padStart(12, "0").slice(0, 2)
  return trimZeros(`${whole}.${fraction}`)
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value
}

app
  /**
   * What this organization has used so far this month, rated.
   *
   * Rated at read time against the price book in force, never stored — the same rule the project
   * list follows. A stored figure is wrong the moment a rate changes, and wrong in a way nobody can
   * reconstruct.
   *
   * `bucket = 'day'` only: the same usage is rolled up at minute, hour *and* day grain, and summing
   * across buckets would show a customer three times what they used.
   */
  .get(
    "/usage",
    describeRoute({
      description: "Metered usage so far this period, rated against the current price book",
      responses: {
        200: {
          description: "Usage",
          content: { "application/json": { schema: resolver(billingSchemaUsageResponse) } },
        },
        403: { description: "Caller lacks usage:read", ...errorResponse },
      },
    }),
    requirePermission("usage:read"),
    async (c) => {
      const organizationId = c.var.organization.id
      const periodStart = startOfMonth()
      const periodEnd = new Date()

      const book = await db
        .selectFrom("priceBook")
        .select(["id", "overheadBps"])
        .where("effectiveAt", "<=", periodEnd)
        .orderBy("effectiveAt", "desc")
        .orderBy("version", "desc")
        .executeTakeFirst()

      // A deployment with no price book would rate everything at zero and show every customer a
      // free product. That is a seeding bug, and it should say so rather than produce a bill.
      if (book === undefined) {
        return throwConflict(c, "No active price book; usage cannot be rated")
      }

      const rows = await db
        .selectFrom("usageRollup")
        .select(["dimension", sql<string>`sum(quantity)::text`.as("quantity")])
        .where("organizationId", "=", organizationId)
        .where("bucket", "=", "day")
        .where("bucketStart", ">=", periodStart)
        .where("bucketStart", "<", periodEnd)
        .groupBy("dimension")
        .execute()

      const items = await db
        .selectFrom("priceBookItem")
        .select(["dimension", "unitMicroUsd"])
        .where("priceBookId", "=", book.id)
        .execute()
      const rates = new Map(items.map((item) => [item.dimension, item.unitMicroUsd]))

      let subtotal = 0n
      const lines = rows
        .map((row) => {
          const rate = rates.get(row.dimension)
          if (rate === undefined) throw new Error(`No price book entry for ${row.dimension}`)
          const amount = rateTimesQuantity(String(rate), row.quantity)
          subtotal += amount

          const display = DIMENSION_DISPLAY[row.dimension] ?? {
            label: row.dimension,
            unit: "units",
            divisor: 1,
          }
          return {
            dimension: row.dimension,
            label: display.label,
            quantity: displayQuantity(row.quantity, display.divisor),
            unit: display.unit,
            amountMicroUsd: amount.toString(),
          }
        })
        // Most expensive first: a usage list is read to find out where the money went.
        .sort((a, b) => (BigInt(b.amountMicroUsd) > BigInt(a.amountMicroUsd) ? 1 : -1))

      const platformOverhead = overhead(subtotal, book.overheadBps)
      const total = subtotal + platformOverhead

      /*
        Burn averaged over the days elapsed, not extrapolated from the last one.

        A single busy day would otherwise tell a customer they have three days of credit left when
        they have thirty — and the number under a balance is one people act on.
      */
      const elapsedDays = Math.max(1, (periodEnd.getTime() - periodStart.getTime()) / 86_400_000)
      const burnPerDay = total / BigInt(Math.ceil(elapsedDays))

      return c.json({
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        lines,
        subtotalMicroUsd: subtotal.toString(),
        overheadMicroUsd: platformOverhead.toString(),
        totalMicroUsd: total.toString(),
        overheadBps: book.overheadBps,
        burnPerDayMicroUsd: burnPerDay.toString(),
      })
    },
  )
  /**
   * Past statements, newest first.
   *
   * Draft statements are included. A statement for the month in progress is a real thing a customer
   * wants to see, and hiding it until it is finalized means the billing page shows nothing at all
   * for the period they are actually spending in.
   */
  .get(
    "/statements",
    describeRoute({
      description: "Past statements",
      responses: {
        200: {
          description: "Statements",
          content: { "application/json": { schema: resolver(billingSchemaStatementsResponse) } },
        },
        403: { description: "Caller lacks billing:read", ...errorResponse },
      },
    }),
    requirePermission("billing:read"),
    async (c) => {
      const rows = await db
        .selectFrom("statement")
        .select([
          "id",
          "periodStart",
          "periodEnd",
          "status",
          "subtotalMicroUsd",
          "overheadMicroUsd",
          "totalMicroUsd",
          "finalizedAt",
        ])
        .where("organizationId", "=", c.var.organization.id)
        // Voided statements are not history a customer should be reconciling against; they are a
        // correction, and the replacement is the one that counts.
        .where("status", "!=", "void")
        .orderBy("periodStart", "desc")
        .limit(24)
        .execute()

      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          periodStart: row.periodStart.toISOString(),
          periodEnd: row.periodEnd.toISOString(),
          status: row.status,
          subtotalMicroUsd: row.subtotalMicroUsd.toString(),
          overheadMicroUsd: row.overheadMicroUsd.toString(),
          totalMicroUsd: row.totalMicroUsd.toString(),
          finalizedAt: row.finalizedAt?.toISOString() ?? null,
        })),
      })
    },
  )

export default app
