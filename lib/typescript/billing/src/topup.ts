import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import Stripe from "stripe"
import { v7 } from "uuid"
import { post } from "./ledger"
import { creditedAmount, MINIMUM_TOPUP, type MicroUsd, processingFee } from "./money"

let cachedStripe: Stripe | undefined

export function stripe(): Stripe {
  if (cachedStripe) return cachedStripe
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error("Missing required environment variable: STRIPE_SECRET_KEY")
  cachedStripe = new Stripe(key)
  return cachedStripe
}

/** Test seam. Drops the memoized client so the next call rebuilds from the environment. */
export function resetStripeClient(): void {
  cachedStripe = undefined
}

export class BelowMinimumTopupError extends Error {
  override readonly name = "BelowMinimumTopupError"

  constructor(readonly minimum: MicroUsd) {
    super(`Top-ups must be at least ${minimum.toString()} micro-USD`)
  }
}

export type TopupQuote = {
  /** What the card is charged. */
  chargeMicroUsd: MicroUsd
  /** Stripe's cut, passed through and shown as its own line. */
  feeMicroUsd: MicroUsd
  /** What lands in the balance. */
  creditMicroUsd: MicroUsd
}

/**
 * What a top-up of `amount` actually buys.
 *
 * Quoted before the charge so the fee can be shown on the confirmation screen
 * rather than discovered afterwards as a balance smaller than the amount paid.
 */
export function quote(amount: MicroUsd): TopupQuote {
  if (amount < MINIMUM_TOPUP) throw new BelowMinimumTopupError(MINIMUM_TOPUP)
  return {
    chargeMicroUsd: amount,
    feeMicroUsd: processingFee(amount),
    creditMicroUsd: creditedAmount(amount),
  }
}

/**
 * Start a top-up.
 *
 * The `topup` row is written before the PaymentIntent exists, so a crash between
 * the two leaves a `pending` row to reconcile rather than a charge with nothing
 * pointing at it. Nothing is credited here — only the webhook credits, because
 * only the webhook knows the money actually moved.
 */
export async function begin(
  db: Kysely<DB>,
  input: {
    organizationId: string
    amountMicroUsd: MicroUsd
    initiatedBy: "user" | "auto_reload"
    stripeCustomerId: string
    paymentMethodId?: string
  },
): Promise<{ topupId: string; clientSecret: string | null; quote: TopupQuote }> {
  const q = quote(input.amountMicroUsd)
  const topupId = v7()

  await db
    .insertInto("topup")
    .values({
      id: topupId,
      organizationId: input.organizationId,
      amountMicroUsd: q.chargeMicroUsd,
      creditedMicroUsd: q.creditMicroUsd,
      status: "pending",
      initiatedBy: input.initiatedBy,
    })
    .execute()

  const intent = await stripe().paymentIntents.create(
    {
      amount: Number(q.chargeMicroUsd / 10_000n),
      currency: "usd",
      customer: input.stripeCustomerId,
      ...(input.paymentMethodId
        ? { payment_method: input.paymentMethodId, off_session: true, confirm: true }
        : { automatic_payment_methods: { enabled: true } }),
      metadata: {
        topup_id: topupId,
        organization_id: input.organizationId,
      },
    },
    // Stripe deduplicates on this, so a retried request reuses the same intent
    // instead of charging the card twice.
    { idempotencyKey: `topup:${topupId}` },
  )

  await db
    .updateTable("topup")
    .set({ stripePaymentIntentId: intent.id, status: "processing", updatedAt: new Date() })
    .where("id", "=", topupId)
    .execute()

  return { topupId, clientSecret: intent.client_secret, quote: q }
}

/**
 * Credit a succeeded payment.
 *
 * Three postings, summing to zero: the money arrives from Stripe, most of it
 * becomes spendable credit, and the processing fee becomes revenue that offsets
 * what Stripe took. The ledger's idempotency key is the PaymentIntent id, so a
 * redelivered webhook posts nothing the second time.
 */
export async function settle(
  db: Kysely<DB>,
  paymentIntentId: string,
): Promise<{ credited: boolean; organizationId: string | null }> {
  const topup = await db
    .selectFrom("topup")
    .selectAll()
    .where("stripePaymentIntentId", "=", paymentIntentId)
    .executeTakeFirst()

  if (!topup) return { credited: false, organizationId: null }
  if (topup.status === "succeeded") {
    return { credited: false, organizationId: topup.organizationId }
  }

  const charge = BigInt(topup.amountMicroUsd)
  const credit = BigInt(topup.creditedMicroUsd)
  const fee = charge - credit

  const { transactionId } = await post(db, {
    organizationId: topup.organizationId,
    kind: "topup",
    idempotencyKey: `stripe:pi:${paymentIntentId}`,
    referenceType: "topup",
    referenceId: topup.id,
    description: "Credit top-up",
    postings: [
      { account: "stripe_clearing", amount: -charge },
      { account: "user_credit", amount: credit },
      { account: "platform_revenue", amount: fee },
    ],
  })

  await db
    .updateTable("topup")
    .set({ status: "succeeded", creditTransactionId: transactionId, updatedAt: new Date() })
    .where("id", "=", topup.id)
    .execute()

  return { credited: true, organizationId: topup.organizationId }
}

export async function fail(
  db: Kysely<DB>,
  paymentIntentId: string,
  failureCode: string | null,
): Promise<void> {
  await db
    .updateTable("topup")
    .set({ status: "failed", failureCode, updatedAt: new Date() })
    .where("stripePaymentIntentId", "=", paymentIntentId)
    .where("status", "!=", "succeeded")
    .execute()
}
