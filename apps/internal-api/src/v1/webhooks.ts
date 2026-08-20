import { crudBackgroundJob } from "@lib/dao"
import { db, type JsonObject } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { createHmac, timingSafeEqual } from "node:crypto"
import { EmptyObject } from "../utils/common.serializer"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer"
import { throwBadRequest, throwUnauthenticated } from "../utils/http-exception"

const SIGNATURE_HEADER = "x-hub-signature-256"
const EVENT_HEADER = "x-github-event"
const DELIVERY_HEADER = "x-github-delivery"

/**
 * One GitHub App has exactly one webhook URL, so this is the single receiver for
 * every event type, dispatching by `X-GitHub-Event`. Three areas of the original
 * design each assumed their own endpoint; only one can exist.
 */
const app = new Hono().post(
  "/github",
  describeRoute({
    description: "Receives every GitHub App webhook delivery",
    responses: {
      200: {
        description: "Delivery accepted",
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
    const secret = process.env.GITHUB_WEBHOOK_SECRET
    if (!secret) {
      return throwUnauthenticated(c, "Webhook signing is not configured")
    }

    const signature = c.req.header(SIGNATURE_HEADER) ?? null
    const event = c.req.header(EVENT_HEADER) ?? null
    const delivery = c.req.header(DELIVERY_HEADER) ?? null
    if (signature === null || event === null || delivery === null) {
      return throwBadRequest(c, "Delivery is missing required headers")
    }

    // The signature covers the raw bytes, so it must be verified before the body
    // is parsed — a re-serialized JSON body will not match.
    const raw = await c.req.text()
    if (!verifySignature(raw, signature, secret)) {
      return throwUnauthenticated(c, "Invalid signature")
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return throwBadRequest(c, "Delivery body is not JSON")
    }

    // Acknowledge fast and process out of band. GitHub retries on a non-2xx and
    // times out at ten seconds, so doing the work inline would turn a slow merge
    // into a duplicate delivery. The delivery id is the idempotency key, so a
    // retry of a delivery we already queued is a no-op rather than a second job.
    await crudBackgroundJob(db).enqueueOnce({
      kind: jobKind(event),
      payload: { event, delivery, body: payload } as unknown as JsonObject,
      state: "queued",
      priority: 0,
      runAt: new Date(),
      attempt: 0,
      maxAttempts: 5,
      idempotencyKey: `github:${delivery}`,
    })

    return c.json({})
  },
)

function verifySignature(raw: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  const a = Buffer.from(signature, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Which worker picks the delivery up.
 *
 * Unrecognised events are still queued under a catch-all rather than dropped:
 * GitHub sends events we did not subscribe to when an app's permissions change,
 * and a delivery that vanished is much harder to debug than one sitting in a
 * queue with nothing to run it.
 */
function jobKind(event: string): string {
  switch (event) {
    case "installation":
    case "installation_repositories":
      return "github.installation.sync"
    case "push":
      return "github.push"
    case "pull_request":
      return "github.pull_request"
    case "ping":
      return "github.ping"
    default:
      return "github.unhandled"
  }
}

export default app
