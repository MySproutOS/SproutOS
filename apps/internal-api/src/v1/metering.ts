import { parseBatch, verify } from "@lib/metering"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwUnauthenticated } from "../utils/http-exception"
import { meteringSchemaResponse } from "./metering.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const SIGNATURE_HEADER = "x-metering-signature"

/** How far out of step with this clock a batch may be and still be accepted. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * Usage ingest (ADR 0014).
 *
 * The other end of the pipeline the metering agent posts into. Every node runs an agent; each signs
 * a batch with a shared key and posts it here.
 *
 * **Unauthenticated by session, authenticated by signature.** The caller is a DaemonSet, not a
 * person — there is no session to present, and the HMAC is what makes the batch trustworthy. It is
 * the same shape as the GitHub and Stripe webhook handlers next door.
 *
 * The route is deliberately dumb: verify, validate, insert. Rating happens later against
 * `price_book`, from a job that reads `rated_at IS NULL`, because money should not be computed on
 * the path that accepts data — an ingest that fails because a price is missing loses the usage as
 * well as the charge.
 */
const app = new Hono().post(
  "/metering/events",
  describeRoute({
    description: "Accepts a signed batch of usage events from a metering agent",
    responses: {
      202: {
        description: "Accepted",
        content: { "application/json": { schema: resolver(meteringSchemaResponse) } },
      },
      400: { description: "Malformed batch", ...errorResponse },
      401: { description: "Missing or invalid signature", ...errorResponse },
    },
  }),
  async (c) => {
    const key = process.env.METERING_INGEST_HMAC_KEY
    if (key === undefined || key === "") {
      // Not a 500. The agent retries on a non-2xx, and a control plane that is missing its key
      // should hold the usage in the agent's buffer rather than accept batches it cannot verify.
      return throwUnauthenticated(c, "Metering ingest is not configured")
    }

    const signature = c.req.header(SIGNATURE_HEADER)
    if (signature === undefined) return throwUnauthenticated(c, "Batch is not signed")

    // Parsed from the raw text, then re-canonicalised from the parsed values — the signature covers
    // a canonical form, not these bytes, precisely so that a proxy re-serialising the JSON does not
    // invalidate it. See `@lib/metering`.
    let raw: unknown
    try {
      raw = JSON.parse(await c.req.text())
    } catch {
      return throwBadRequest(c, "Batch is not JSON")
    }

    const parsed = parseBatch(raw)
    if (!parsed.ok) return throwBadRequest(c, `Malformed batch: ${parsed.reason}`)

    if (!verify(parsed.batch, key, signature)) {
      return throwUnauthenticated(c, "Invalid signature")
    }

    const now = Date.now()
    const rows = parsed.batch.events
      // A batch buffered through a long outage is still worth having; one dated next year is a
      // clock that is wrong, and accepting it would put usage in a partition nobody reads.
      .filter((event) => Math.abs(now - event.occurredAt) <= MAX_SKEW_MS)
      .map((event) => ({
        id: v7(),
        organizationId: event.organizationId,
        projectId: event.projectId,
        // The agent meters pods; every event it sends is a site's compute.
        resourceType: "site",
        dimension: event.dimension,
        quantity: event.quantity.toString(),
        occurredAt: new Date(event.occurredAt),
        nodeId: event.attributes.node ?? null,
        source: parsed.batch.source,
        externalId: event.externalId,
      }))

    if (rows.length > 0) {
      await db
        .insertInto("usageEvent")
        .values(rows)
        // The agent retries a batch it could not confirm, and a retried batch is the same events
        // again. `(source, external_id, occurred_at)` is unique, so a replay inserts nothing rather
        // than billing twice.
        .onConflict((builder) =>
          builder.columns(["source", "externalId", "occurredAt"]).doNothing(),
        )
        .execute()
    }

    return c.json({ accepted: rows.length, received: parsed.batch.events.length }, 202)
  },
)

export default app
