import {
  applyActiveUsage,
  connectUsageEventProducer,
  decimalQuantity,
  parseBatch,
  usageEventRecord,
  verify,
  type UsageEvent,
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

type IngestAttribution = { resourceType: string; resourceId: string | null }

/**
 * Attribute a signed Rust emitter without pretending every resource is a site.
 *
 * Source and dimension are checked together. The HMAC says the batch came from our data plane;
 * this catches an emitter wired to the wrong counter before a perfectly signed bug becomes durable
 * financial history. TypeScript control-plane writers carry these fields in their outbox record.
 */
export function ingestAttribution(
  source: string,
  event: UsageEvent,
): IngestAttribution | undefined {
  if (
    (source === "router-site" || source === "metering-agent") &&
    event.dimension.startsWith("site_")
  ) {
    return { resourceType: "site", resourceId: event.projectId }
  }
  if (source === "search-proxy" && event.dimension.startsWith("es_")) {
    const resourceId = event.attributes.search_index_id
    if (resourceId === undefined || resourceId === "") return undefined
    return { resourceType: "search_index", resourceId }
  }
  if (source === "llm-proxy" && event.dimension.startsWith("ai_")) {
    return { resourceType: "model_request", resourceId: null }
  }
  if (source === "pg-proxy" && event.dimension.startsWith("db_")) {
    return { resourceType: "database", resourceId: null }
  }
  return undefined
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
            version: event.version,
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
 * for rating. The same retry-stable event id updates Valkey's low-latency projection.
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

    const attributed = parsed.batch.events.map((event) => ({
      event,
      attribution: ingestAttribution(parsed.batch.source, event),
    }))
    const invalidAttribution = attributed.findIndex((item) => item.attribution === undefined)
    if (invalidAttribution !== -1) {
      return throwBadRequest(
        c,
        `Malformed batch: events[${invalidAttribution}] dimension is not valid for source or lacks resource attribution`,
      )
    }

    // Which organizations actually exist.
    //
    // A pod's labels can name an organization that has since been deleted, or a label can simply be
    // wrong. Publishing anyway creates durable usage nobody can attribute, and retrying one stale
    // pod label can stall that node's entire usage stream behind a batch that can never succeed.
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

    // And which projects. A project label can be stale for the same reasons.
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
    const events = attributed
      .filter(({ event }) => known.has(event.organizationId))
      // A batch buffered through a long outage is still worth having; one dated next year is a
      // clock that is wrong. Old events remain valid because ClickHouse partitions them by event
      // time and discovers affected grains by its separate storage timestamp.
      .filter(({ event }) => event.occurredAt <= now + MAX_FUTURE_SKEW_MS)
      .map(({ event, attribution }) => {
        if (attribution === undefined) throw new Error("validated metering attribution disappeared")
        const projectId =
          event.projectId !== null && knownProjects.has(event.projectId) ? event.projectId : null
        return usageEventRecord({
          organizationId: event.organizationId,
          projectId,
          resourceType: attribution.resourceType,
          // A site is the project deployment reached by the router. Use only the normalized id;
          // retaining a stale caller-supplied project as resource attribution would undo the
          // normalization immediately above. Other sources carry their own authoritative id.
          resourceId: attribution.resourceType === "site" ? projectId : attribution.resourceId,
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
        })
      })

    const sinks = sinkOverride ?? defaultSinks()
    // Kafka is the durable acceptance boundary. If it cannot replicate the records, this throws
    // and the emitter receives a non-2xx so it keeps its own buffered copy.
    await sinks.publish(events)
    // Do not acknowledge until the live projection also lands. A Valkey failure makes the emitter
    // retry: Kafka receives the same event id and ClickHouse replaces it, while Valkey's
    // version-aware contribution makes the projection idempotent. This repairs the live view without making it the
    // financial authority or allowing its outage to interrupt tenant traffic.
    await sinks.project(events)

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
