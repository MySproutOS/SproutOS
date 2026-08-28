import { crudMeteringOutbox } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { meteringOutboxRelay } from "./metering-outbox"

const reachable = await (async () => {
  try {
    await sql`select 1 from metering_outbox limit 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: string[] = []
const job = { id: v7(), kind: "billing.relay_metering_outbox", payload: {} } as never
const context = { db } as never

afterAll(async () => {
  if (!reachable) return
  if (created.length > 0) await db.deleteFrom("meteringOutbox").where("id", "in", created).execute()
  await db.destroy()
})

function payload(eventId: string) {
  return {
    event_id: eventId,
    organization_id: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
    project_id: null,
    resource_type: "agent_run",
    resource_id: null,
    dimension: "agent_run_second",
    quantity: "1.25",
    occurred_at: "2026-08-26 12:34:56.789",
    window_start: "2026-08-26 12:34:55.539",
    window_end: "2026-08-26 12:34:56.789",
    node_id: null,
    pod_uid: null,
    source: "agent",
    external_id: `${eventId}:agent_run_second`,
    charged_externally: false,
    attributes: {},
    ingested_at: "2026-08-26 12:34:56.790",
    version: "1787747696790",
  }
}

async function insert(): Promise<{ id: string; eventId: string; value: string }> {
  const id = v7()
  const eventId = `event-${id}`
  const body = payload(eventId)
  created.push(id)
  await crudMeteringOutbox(db).create({ id, eventId, payload: body })
  // The production relay correctly claims the oldest global row. Other test files also exercise
  // metering producers against this shared database, though, and Vitest runs those files in
  // parallel. Put this suite's row unambiguously first so each relay invocation claims the event
  // the assertion created instead of an unrelated producer's newly committed row.
  await db
    .updateTable("meteringOutbox")
    .set({ createdAt: new Date("1900-01-01T00:00:00.000Z") })
    .where("id", "=", id)
    .execute()
  const stored = await sql<{ payload: string }>`
    select payload::text as payload from metering_outbox where id = ${id}
  `.execute(db)
  const [row] = stored.rows
  if (row === undefined) throw new Error(`outbox row ${id} was not inserted`)
  return { id, eventId, value: row.payload }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function exists(id: string): Promise<boolean> {
  return (
    (await db.selectFrom("meteringOutbox").select("id").where("id", "=", id).executeTakeFirst()) !==
    undefined
  )
}

describe.skipIf(!reachable)("metering outbox relay", () => {
  it("publishes the exact stored payload before deleting the row", async ({ skip }) => {
    if (!reachable) skip()
    const event = await insert()
    const called = deferred()
    const acknowledged = deferred()
    const sent: { eventId: string; value: string }[][] = []
    const projected: unknown[][] = []

    const run = meteringOutboxRelay({
      batchSize: 1,
      publish: async (events) => {
        sent.push(events)
        called.resolve()
        await acknowledged.promise
      },
      project: (events) => {
        projected.push(events)
        return Promise.resolve()
      },
    })(job, context)

    await called.promise
    try {
      // The Kafka promise has not acknowledged yet, so deletion would be permanent data loss.
      expect(await exists(event.id)).toBe(true)
    } finally {
      acknowledged.resolve()
    }
    await run
    expect(sent).toEqual([[{ eventId: event.eventId, value: event.value }]])
    expect(await exists(event.id)).toBe(false)
    expect(projected).toEqual([
      [
        expect.objectContaining({
          eventId: event.eventId,
          dimension: "agent_run_second",
          quantity: "1.25",
          occurredAt: new Date("2026-08-26T12:34:56.789Z"),
        }),
      ],
    ])
  })

  it("keeps a failed publish for a byte-identical retry", async ({ skip }) => {
    if (!reachable) skip()
    const event = await insert()
    const attempts: { eventId: string; value: string }[][] = []

    const first = meteringOutboxRelay({
      batchSize: 1,
      publish: (events) => {
        attempts.push(events)
        return Promise.reject(new Error("Kafka unavailable"))
      },
      project: () => Promise.reject(new Error("projection must not run before Kafka acknowledges")),
    })

    await expect(first(job, context)).rejects.toThrow("Kafka unavailable")
    expect(await exists(event.id)).toBe(true)

    const second = meteringOutboxRelay({
      batchSize: 1,
      publish: (events) => {
        attempts.push(events)
        return Promise.resolve()
      },
      project: () => Promise.resolve(),
    })
    await second(job, context)

    expect(attempts).toEqual([
      [{ eventId: event.eventId, value: event.value }],
      [{ eventId: event.eventId, value: event.value }],
    ])
    expect(await exists(event.id)).toBe(false)
  })

  it("retains usage until the idempotent Valkey projection succeeds", async ({ skip }) => {
    if (!reachable) skip()
    const event = await insert()
    const published: { eventId: string; value: string }[][] = []

    const first = meteringOutboxRelay({
      batchSize: 1,
      publish: (events) => {
        published.push(events)
        return Promise.resolve()
      },
      project: () => Promise.reject(new Error("Valkey unavailable")),
    })
    await expect(first(job, context)).rejects.toThrow("Valkey unavailable")
    expect(await exists(event.id)).toBe(true)

    await meteringOutboxRelay({
      batchSize: 1,
      publish: (events) => {
        published.push(events)
        return Promise.resolve()
      },
      project: () => Promise.resolve(),
    })(job, context)

    expect(published).toEqual([
      [{ eventId: event.eventId, value: event.value }],
      [{ eventId: event.eventId, value: event.value }],
    ])
    expect(await exists(event.id)).toBe(false)
  })

  it("bounds the Kafka acknowledgement while holding the database lock", async ({ skip }) => {
    if (!reachable) skip()
    const event = await insert()

    const handler = meteringOutboxRelay({
      batchSize: 1,
      publishTimeoutMs: 5,
      publish: () => new Promise(() => {}),
      project: () => Promise.resolve(),
    })

    await expect(handler(job, context)).rejects.toThrow(
      "Kafka did not acknowledge the metering outbox batch within 5ms",
    )
    expect(await exists(event.id)).toBe(true)
  })

  it("bounds the Valkey projection while holding the database lock", async ({ skip }) => {
    if (!reachable) skip()
    const event = await insert()

    const handler = meteringOutboxRelay({
      batchSize: 1,
      projectTimeoutMs: 5,
      publish: () => Promise.resolve(),
      project: () => new Promise(() => {}),
    })

    await expect(handler(job, context)).rejects.toThrow(
      "Valkey did not project the metering outbox batch within 5ms",
    )
    expect(await exists(event.id)).toBe(true)
  })
})
