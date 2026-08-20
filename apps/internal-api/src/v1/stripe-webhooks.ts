import { fail, settle, stripe } from "@lib/billing"
import { db, type JsonObject } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import type Stripe from "stripe"
import { EmptyObject } from "../utils/common.serializer"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer"
import { throwBadRequest, throwUnauthenticated } from "../utils/http-exception"

const SIGNATURE_HEADER = "stripe-signature"

/**
 * Stripe's delivery endpoint.
 *
 * Unauthenticated by necessity — Stripe has no session — so the signature is the
 * only thing standing between this route and anyone who can guess the URL
 * crediting themselves an arbitrary balance. It is verified before the body is
 * read as anything but bytes.
 */
const app = new Hono().post(
  "/stripe",
  describeRoute({
    description: "Receives Stripe webhook deliveries",
    responses: {
      200: {
        description: "Event accepted",
        content: { "application/json": { schema: resolver(EmptyObject) } },
      },
      400: {
        description: "Malformed delivery",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
      401: {
        description: "Signature missing or invalid",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
    },
  }),
  async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) return throwUnauthenticated(c, "Stripe webhook signing is not configured")

    const signature = c.req.header(SIGNATURE_HEADER) ?? null
    if (signature === null) return throwBadRequest(c, "Delivery is missing a signature")

    // constructEvent verifies over the raw bytes and enforces the timestamp
    // tolerance that stops a captured delivery being replayed days later.
    const raw = await c.req.text()
    let event: Stripe.Event
    try {
      event = await stripe().webhooks.constructEventAsync(raw, signature, secret)
    } catch {
      return throwUnauthenticated(c, "Invalid signature")
    }

    // Recording the event before acting on it makes redelivery a no-op: Stripe
    // retries for three days, and a second credit is money we cannot get back.
    const claimed = await db
      .insertInto("stripeWebhookEvent")
      .values({
        stripeEventId: event.id,
        type: event.type,
        payload: event.data.object as unknown as JsonObject,
      })
      .onConflict((oc) => oc.column("stripeEventId").doNothing())
      .returning("stripeEventId")
      .executeTakeFirst()

    if (!claimed) return c.json({})

    try {
      await handle(event)
      await db
        .updateTable("stripeWebhookEvent")
        .set({ processedAt: new Date() })
        .where("stripeEventId", "=", event.id)
        .execute()
    } catch (error) {
      // Left unprocessed with the reason recorded, and a non-2xx so Stripe
      // retries. The claim row stays, so the retry re-enters the same path
      // rather than being swallowed as a duplicate.
      await db
        .updateTable("stripeWebhookEvent")
        .set({ error: error instanceof Error ? error.message : String(error) })
        .where("stripeEventId", "=", event.id)
        .execute()
      throw error
    }

    return c.json({})
  },
)

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object
      await settle(db, intent.id)
      return
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object
      await fail(db, intent.id, intent.last_payment_error?.code ?? null)
      return
    }
    case "charge.refunded":
    case "charge.dispute.created":
      return
    default:
      return
  }
}

export default app
