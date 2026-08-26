import {
  applyActiveUsage,
  connectUsageEventProducer,
  decimalQuantity,
  parseBatch,
  usageEventRecord,
  verify,
  type UsageEventProducer,
  type UsageEventRecord,
} from "@lib/metering"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Redis } from "ioredis"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwUnauthenticated } from "../utils/http-exception"
import { meteringSchemaResponse } from "./metering.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const SIGNATURE_HEADER = "x-metering-signature"

/** Future skew is invalid; an old event may be a durable buffer finally recovering. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

export type MeteringSinks = {
  publish: (events: UsageEventRecord[]) => Promise<void>
  project: (events: UsageEventRecord[]) => Promise<void>
}

let producer: Promise<UsageEventProducer> | undefined
let valkey: Redis | undefined
let sinkOverride: MeteringSinks | undefined

/**
 * Publish through the process-wide producer without letting one failed connection poison every
 * later request. Empty accepted batches do not need Kafka at all.
 */
export async function publishUsageEvents(
  events: UsageEventRecord[],
  connect: typeof connectUsageEventProducer = connectUsageEventProducer,
): Promise<void> {
  if (events.length === 0) return

  if (producer === undefined) {
    const connecting = connect()
    producer = connecting
    try {
      await connecting
    } catch (error) {
      if (producer === connecting) producer = undefined
      throw error
    }
  }

  await (await producer).send(events)
}

function defaultSinks(): MeteringSinks {
  return {
    publish: publishUsageEvents,
    project: async (events) => {
      if (events.length === 0) return
      valkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
      await Promise.all(
        events.map(async (event) => {
          await applyActiveUsage(valkey!, {
            eventId: event.eventId,
            organizationId: event.organizationId,
            projectId: event.projectId,
            dimension: event.dimension,
            quantity: event.quantity,
            occurredAt: event.occurredAt,
          })
        }),
      )
    },
  }
}

/** Replace external sinks in route tests; passing no value restores production behavior. */
export function setMeteringSinksForTest(sinks?: MeteringSinks): void {
  sinkOverride = sinks
}

export async function closeMeteringSinks(): Promise<void> {
  const connected = producer === undefined ? undefined : await producer.catch(() => undefined)
  await connected?.disconnect()
  producer = undefined
  if (valkey !== undefined) await valkey.quit()
  valkey = undefined
}

/**
 * Usage ingest (ADR 0028, superseding ADR 0014's Postgres raw store).
 *
 * The other end of the pipeline the metering agent posts into. Every node runs an agent; each signs
 * a batch with a shared key and posts it here.
 *
 * **Unauthenticated by session, authenticated by signature.** The caller is a DaemonSet, not a
 * person — there is no session to present, and the HMAC is what makes the batch trustworthy. It is
 * the same shape as the GitHub and Stripe webhook handlers next door.
 *
 * The route verifies, validates and normalizes, then waits for Kafka's replica acknowledgements.
 * ClickHouse stores the immutable raw record; a later job imports absolute rollups into Postgres
 * for rating. Valkey is only the rebuildable low-latency projection.
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

    // Which organizations actually exist.
    //
    // A pod's labels can name an organization that has since been deleted, or a label can simply be
    // wrong. Inserting anyway violates `usage_event_organization_id_fkey` and returns a 500 — which
    // the agent retries forever, so one stale pod label stalls that node's entire usage stream
    // behind a batch that can never succeed. Observed exactly that way with a real batch from a real
    // node.
    //
    // Dropped rather than rejected: the rest of the batch is good, and usage for an organization
    // that no longer exists cannot be billed to anybody in any case.
    const named = [...new Set(parsed.batch.events.map((event) => event.organizationId))]
    const known = new Set(
      (
        await db
          .selectFrom("organization")
          .select("id")
          .where("id", "in", named)
          .where("deletedAt", "is", null)
          .execute()
      ).map((row) => row.id),
    )

    // And which projects. A project label can be stale for the same reasons, and the same insert
    // fails on `usage_event_project_id_fkey` instead.
    //
    // The remedy is different, though, and the difference is the point. An unknown *organization*
    // means there is nobody to bill, so the event is dropped. An unknown *project* means the
    // organization is real and genuinely consumed the resource — only the sub-attribution is
    // unverifiable. Dropping that event would lose revenue for work that was actually done, so the
    // event is kept and `project_id` is nulled, which the column already allows for standalone
    // services that belong to no project.
    const namedProjects = [
      ...new Set(
        parsed.batch.events
          .map((event) => event.projectId)
          .filter((id): id is string => id !== null),
      ),
    ]
    const knownProjects =
      namedProjects.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db
                .selectFrom("project")
                .select("id")
                .where("id", "in", namedProjects)
                .where("deletedAt", "is", null)
                .execute()
            ).map((row) => row.id),
          )

    const now = Date.now()
    const events = parsed.batch.events
      .filter((event) => known.has(event.organizationId))
      // A batch buffered through a long outage is still worth having; one dated next year is a
      // clock that is wrong. Old events remain valid because ClickHouse partitions them by event
      // time and discovers affected grains by its separate storage timestamp.
      .filter((event) => event.occurredAt <= now + MAX_FUTURE_SKEW_MS)
      .map((event) =>
        usageEventRecord({
          organizationId: event.organizationId,
          projectId:
            event.projectId !== null && knownProjects.has(event.projectId) ? event.projectId : null,
          // The agent meters pods; every event it sends is a site's compute.
          resourceType: "site",
          resourceId: null,
          dimension: event.dimension,
          quantity: decimalQuantity(event.quantity),
          occurredAt: new Date(event.occurredAt),
          windowStart: null,
          windowEnd: null,
          nodeId: event.attributes.node ?? null,
          podUid: event.attributes.pod_uid ?? null,
          source: parsed.batch.source,
          externalId: event.externalId,
          chargedExternally: false,
          attributes: event.attributes,
        }),
      )

    const sinks = sinkOverride ?? defaultSinks()
    // Kafka is the durable acceptance boundary. If it cannot replicate the records, this throws
    // and the emitter receives a non-2xx so it keeps its own buffered copy.
    await sinks.publish(events)
    try {
      await sinks.project(events)
    } catch (error) {
      // Valkey is a rebuildable low-latency view, never the authority. Rejecting an event Kafka has
      // already acknowledged would cause a retry and would still not repair this projection.
      console.warn("[metering] active Valkey projection failed", error)
    }

    return c.json(
      {
        accepted: events.length,
        received: parsed.batch.events.length,
        unknownOrganizations: named.filter((id) => !known.has(id)).length,
        unknownProjects: namedProjects.filter((id) => !knownProjects.has(id)).length,
      },
      202,
    )
  },
)

export default app
