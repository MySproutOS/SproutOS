import { crudMeteringOutbox, fetchMeteringOutbox } from "@lib/dao"
import {
  applyActiveUsage,
  connectUsageEventProducer,
  type ActiveUsageEvent,
  type UsageEventProducer,
} from "@lib/metering"
import { Redis } from "ioredis"
import type { JobHandler } from "./worker"

export const METERING_OUTBOX_BATCH_SIZE = 500
export const METERING_OUTBOX_PUBLISH_TIMEOUT_MS = 30_000
export const METERING_OUTBOX_PROJECT_TIMEOUT_MS = 10_000

export type MeteringOutboxRelayDependencies = {
  publish?: UsageEventProducer["sendEncoded"]
  project?: (events: ActiveUsageEvent[]) => Promise<void>
  batchSize?: number
  publishTimeoutMs?: number
  projectTimeoutMs?: number
}

let producer: Promise<UsageEventProducer> | undefined
let valkey: Redis | undefined

async function publish(events: { eventId: string; value: string }[]): Promise<void> {
  producer ??= connectUsageEventProducer()
  try {
    await (await producer).sendEncoded(events)
  } catch (error) {
    // A failed connection promise must not poison every later job in this process. The outbox row
    // remains, so the next scheduled relay gets a fresh connection and publishes the same bytes.
    producer = undefined
    throw error
  }
}

async function project(events: ActiveUsageEvent[]): Promise<void> {
  valkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  await Promise.all(events.map(async (event) => await applyActiveUsage(valkey!, event)))
}

/**
 * Publish committed TypeScript usage from Postgres's transactional outbox.
 *
 * The Kafka acknowledgement happens while the selected rows are locked. Rows are deleted only
 * afterward, in the same transaction. A publish failure rolls the transaction back and leaves the
 * rows available for retry; a crash after Kafka acknowledges but before deletion republishes the
 * same stable event ids, which ClickHouse deduplicates.
 *
 * The active projection also runs before deletion so prompt feedback normally sees the event
 * without waiting for hourly reconciliation. If it fails, the row remains: retrying republishes
 * the same Kafka event id and reapplies the same version-aware Valkey contribution, so neither
 * destination double-counts. ClickHouse reconciliation remains the repair path after eviction.
 */
export function meteringOutboxRelay(
  dependencies: MeteringOutboxRelayDependencies = {},
): JobHandler {
  const publishBatch = dependencies.publish ?? publish
  const projectBatch = dependencies.project ?? project
  const batchSize = dependencies.batchSize ?? METERING_OUTBOX_BATCH_SIZE
  const publishTimeoutMs = dependencies.publishTimeoutMs ?? METERING_OUTBOX_PUBLISH_TIMEOUT_MS
  const projectTimeoutMs = dependencies.projectTimeoutMs ?? METERING_OUTBOX_PROJECT_TIMEOUT_MS

  return async (_job, { db }) => {
    const delivered = await db.transaction().execute(async (tx) => {
      const rows = await fetchMeteringOutbox(tx).claim(batchSize)
      if (rows.length === 0) return []

      const encoded = rows.map((row) => ({
        eventId: row.eventId,
        value: row.payload,
      }))
      await within(
        publishBatch(encoded),
        publishTimeoutMs,
        "Kafka did not acknowledge the metering outbox batch",
      )
      await within(
        projectBatch(rows.map((row) => activeEvent(row.eventId, row.payload))),
        projectTimeoutMs,
        "Valkey did not project the metering outbox batch",
      )
      await crudMeteringOutbox(tx).remove(rows.map((row) => row.id))
      return rows
    })

    if (delivered.length === 0) return
    console.info(`[jobs] published ${delivered.length} metering outbox event(s)`)
  }
}

function activeEvent(eventId: string, encoded: string): ActiveUsageEvent {
  const payload: unknown = JSON.parse(encoded)
  if (!isRecord(payload)) {
    throw new Error(`metering outbox event ${eventId} is not an object`)
  }

  const organizationId = payload.organization_id
  const projectId = payload.project_id
  const dimension = payload.dimension
  const quantity = payload.quantity
  const occurredAt = payload.occurred_at
  const version = payload.version

  if (
    typeof organizationId !== "string" ||
    (projectId !== null && typeof projectId !== "string") ||
    typeof dimension !== "string" ||
    typeof quantity !== "string" ||
    typeof occurredAt !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(`metering outbox event ${eventId} cannot be projected`)
  }

  // ClickHouse JSONEachRow timestamps use a space and no zone. They are UTC by contract; spelling
  // that fact here prevents Node from interpreting the same bytes in the host's local timezone.
  const timestamp = new Date(`${occurredAt.replace(" ", "T")}Z`)
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`metering outbox event ${eventId} has an invalid occurred_at`)
  }

  return {
    eventId,
    organizationId,
    projectId,
    dimension,
    quantity,
    occurredAt: timestamp,
    version,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${message} within ${milliseconds}ms`))
        }, milliseconds)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
