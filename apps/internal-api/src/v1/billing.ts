import {
  availableBalance,
  BelowMinimumTopupError,
  begin,
  MINIMUM_TOPUP,
  quote,
  stripe,
} from "@lib/billing"
import { crudAuditLog } from "@lib/dao"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { requirePermission } from "../rbac"
import { authMiddleware } from "../middleware"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest } from "../utils/http-exception"
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
  billingSchemaTransactionsResponse,
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

      const available = await availableBalance(db, organization.id)
      const posted = await availableBalance(db, organization.id, "user_credit")

      return c.json({
        balanceMicroUsd: posted.toString(),
        heldMicroUsd: (posted - available).toString(),
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

export default app
