import {
  canonical,
  readActiveUsage,
  sign,
  usageEventId,
  usageEventRecord,
  type UsageBatch,
  type UsageEventProducer,
  type UsageEventRecord,
} from "@lib/metering"
import {
  clickhouse,
  usageBackupManifestDdl,
  usageEventDeadLetterDdl,
  usageEventDeadLetterViewDdl,
  usageEventMaterializedViewDdl,
  usageEventQueueDdl,
  usageEventRawDdl,
  usageEventStoredAtDdl,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { Kafka } from "kafkajs"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import app from "../index"
import { closeMeteringSinks, publishUsageEvents, setMeteringSinksForTest } from "./metering"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()
const kafkaBroker = process.env.KAFKA_BROKERS_HOST ?? process.env.KAFKA_BROKERS ?? "localhost:29092"
const kafkaReachable = await (async () => {
  const admin = new Kafka({ clientId: "metering-route-test", brokers: [kafkaBroker] }).admin()
  try {
    await admin.connect()
    return (await admin.listTopics()).includes(
      process.env.KAFKA_USAGE_EVENT_TOPIC ?? "usage-events",
    )
  } catch {
    return false
  } finally {
    await admin.disconnect().catch(() => {})
  }
})()

if (!kafkaReachable && process.env.REQUIRE_KAFKA !== undefined) {
  throw new Error("The usage-events Kafka topic is not reachable; the live ingest test cannot skip")
}

const KEY = "test-metering-key"
let organizationId: string
const published: UsageEventRecord[] = []
const testSinks = {
  publish: (events: UsageEventRecord[]) => {
    published.push(...events)
    return Promise.resolve()
  },
  project: () => Promise.resolve(),
}

function batchOf(events: Partial<UsageBatch["events"][number]>[]): UsageBatch {
  return {
    source: "router-site",
    events: events.map((event, index) => ({
      externalId: `e-${v7()}-${index}`,
      organizationId,
      projectId: null,
      dimension: "site_gib_second",
      quantity: 0.25,
      occurredAt: Date.now(),
      attributes: { node: "node-under-test" },
      ...event,
    })),
  }
}

async function post(batch: UsageBatch, signature?: string) {
  const response = await app.request("/v1/internal/metering/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-metering-signature": signature ?? sign(batch, KEY),
    },
    // The wire format: ordinary JSON, `quantity` as a number. The signature covers a canonical form
    // rebuilt from these values, not these bytes.
    body: JSON.stringify({
      source: batch.source,
      events: batch.events.map((event) => ({
        external_id: event.externalId,
        organization_id: event.organizationId,
        project_id: event.projectId,
        charged_externally: event.chargedExternally,
        dimension: event.dimension,
        quantity: event.quantity,
        occurred_at: event.occurredAt,
        attributes: event.attributes,
      })),
    }),
  })

  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    // Hono's default 500 is plain text. Status is the assertion for that path.
  }
  return {
    status: response.status,
    json,
  }
}

function storedFor(externalId: string) {
  return published.filter((event) => event.externalId === externalId)
}

beforeAll(async () => {
  process.env.METERING_INGEST_HMAC_KEY = KEY
  setMeteringSinksForTest(testSinks)
  const owner = await createTestUser("metering-owner")
  organizationId = v7()
  trackOrganization(organizationId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `metering-${organizationId.slice(-12)}`,
      name: "Metering",
      kind: "team",
      ownerUserId: owner.id,
    })
    .execute()
})

afterAll(async () => {
  setMeteringSinksForTest()
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!reachable)("metering ingest", () => {
  it("reconnects after a failed default Kafka connection and skips Kafka for an empty batch", async () => {
    await closeMeteringSinks()
    const send = vi.fn<UsageEventProducer["send"]>(() => Promise.resolve())
    const sendEncoded = vi.fn<UsageEventProducer["sendEncoded"]>(() => Promise.resolve())
    const disconnect = vi.fn<UsageEventProducer["disconnect"]>(() => Promise.resolve())
    const connect = vi
      .fn<() => Promise<UsageEventProducer>>()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue({ send, sendEncoded, disconnect })
    const event = usageEventRecord({
      organizationId,
      projectId: null,
      resourceType: "site",
      resourceId: null,
      dimension: "site_request",
      quantity: "1",
      occurredAt: new Date(),
      windowStart: null,
      windowEnd: null,
      nodeId: null,
      podUid: null,
      source: "test",
      externalId: v7(),
      chargedExternally: false,
      attributes: {},
    })

    await publishUsageEvents([], connect)
    expect(connect).not.toHaveBeenCalled()
    await expect(publishUsageEvents([event], connect)).rejects.toThrow("broker unavailable")
    await publishUsageEvents([event], connect)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith([event])
    await closeMeteringSinks()
  })

  it("stores a signed batch", async () => {
    const batch = batchOf([{}])
    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.accepted).toBe(1)

    const [stored] = storedFor(batch.events[0].externalId)
    expect(stored?.organizationId).toBe(organizationId)
    expect(stored?.dimension).toBe("site_gib_second")
    expect(stored?.resourceType).toBe("site")
    expect(stored?.resourceId).toBeNull()
    expect(Number(stored?.quantity)).toBeCloseTo(0.25, 9)
    expect(stored?.nodeId).toBe("node-under-test")
    expect(stored?.chargedExternally).toBe(false)
  })

  it("keeps BYO model usage visible without marking platform-key usage externally paid", async () => {
    const byo = batchOf([
      {
        dimension: "ai_input_token",
        quantity: 41,
        chargedExternally: true,
      },
      {
        dimension: "ai_output_token",
        quantity: 58,
        chargedExternally: true,
      },
    ])
    byo.source = "llm-proxy"
    const platform = batchOf([
      {
        dimension: "ai_input_token",
        quantity: 7,
        chargedExternally: false,
      },
    ])
    platform.source = "llm-proxy"

    expect((await post(byo)).status).toBe(202)
    expect((await post(platform)).status).toBe(202)

    expect(byo.events.map((event) => storedFor(event.externalId)[0]?.chargedExternally)).toEqual([
      true,
      true,
    ])
    expect(storedFor(platform.events[0].externalId)[0]?.chargedExternally).toBe(false)
  })

  it("covers charged_externally with the signature", async () => {
    const signed = batchOf([{ dimension: "ai_input_token", quantity: 1, chargedExternally: true }])
    signed.source = "llm-proxy"
    const signature = sign(signed, KEY)
    signed.events[0].chargedExternally = false

    expect((await post(signed, signature)).status).toBe(401)
  })

  it("refuses externally charged usage from a source that cannot use customer credentials", async () => {
    const batch = batchOf([{ chargedExternally: true }])

    expect((await post(batch)).status).toBe(400)
  })

  it("derives resource attribution from the signed source and dimension", async () => {
    const searchIndexId = v7()
    const batch = batchOf([
      {
        dimension: "es_search_unit",
        quantity: 1,
        attributes: { search_index_id: searchIndexId },
      },
    ])
    batch.source = "search-proxy"

    expect((await post(batch)).status).toBe(202)
    const [stored] = storedFor(batch.events[0].externalId)
    expect(stored?.resourceType).toBe("search_index")
    expect(stored?.resourceId).toBe(searchIndexId)
  })

  it("rejects a signed source/dimension mismatch instead of misclassifying it", async () => {
    const batch = batchOf([{ dimension: "es_search_unit" }])

    const response = await post(batch)

    expect(response.status).toBe(400)
    expect(storedFor(batch.events[0].externalId)).toHaveLength(0)
  })

  it("refuses a batch whose quantity was altered after signing", async () => {
    // The entire point of signing. A proxy or a compromised node that inflates a number must not be
    // able to bill for it.
    const batch = batchOf([{}])
    const signature = sign(batch, KEY)
    const tampered = { ...batch, events: [{ ...batch.events[0], quantity: 9999 }] }

    const response = await post(tampered, signature)

    expect(response.status).toBe(401)
    expect(storedFor(tampered.events[0].externalId)).toHaveLength(0)
  })

  it("refuses a batch signed with the wrong key", async () => {
    const batch = batchOf([{}])

    expect((await post(batch, sign(batch, "not-the-key"))).status).toBe(401)
  })

  it("refuses an unsigned batch", async () => {
    const batch = batchOf([{}])
    const response = await app.request("/v1/internal/metering/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: batch.source, events: [] }),
    })

    expect(response.status).toBe(401)
  })

  it("does not acknowledge a batch Kafka failed to replicate", async () => {
    const batch = batchOf([{}])
    setMeteringSinksForTest({
      publish: () => Promise.reject(new Error("Kafka unavailable")),
      project: () => Promise.resolve(),
    })
    try {
      expect((await post(batch)).status).toBe(500)
      expect(storedFor(batch.events[0].externalId)).toHaveLength(0)
    } finally {
      setMeteringSinksForTest(testSinks)
    }
  })

  it("makes the emitter retry until the Valkey projection succeeds", async () => {
    const batch = batchOf([{}])
    setMeteringSinksForTest({
      publish: testSinks.publish,
      project: () => Promise.reject(new Error("Valkey unavailable")),
    })
    try {
      expect((await post(batch)).status).toBe(500)
      expect(storedFor(batch.events[0].externalId)).toHaveLength(1)
    } finally {
      setMeteringSinksForTest(testSinks)
    }

    expect((await post(batch)).status).toBe(202)
    const retries = storedFor(batch.events[0].externalId)
    expect(retries).toHaveLength(2)
    expect(retries[0]?.eventId).toBe(retries[1]?.eventId)
  })

  it("does not bill twice for a replayed batch", async () => {
    // The agent retries a batch it could not confirm, so the same events arrive again. Unique on
    // (source, external_id, occurred_at).
    const batch = batchOf([{}])

    expect((await post(batch)).status).toBe(202)
    expect((await post(batch)).status).toBe(202)

    const replays = storedFor(batch.events[0].externalId)
    expect(replays).toHaveLength(2)
    expect(replays[0]?.eventId).toBe(replays[1]?.eventId)
  })

  it("drops an event dated far in the future without rejecting the batch", async () => {
    // A node with a broken clock should not poison a batch that is otherwise fine, and its event
    // should not land in a partition nobody reads.
    const good = batchOf([{}])
    const batch: UsageBatch = {
      source: good.source,
      events: [
        good.events[0],
        {
          ...good.events[0],
          externalId: `future-${v7()}`,
          occurredAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
        },
      ],
    }

    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.received).toBe(2)
    expect(response.json.accepted).toBe(1)
  })

  it("accepts an old event recovered from a durable emitter buffer", async () => {
    const batch = batchOf([{ occurredAt: Date.now() - 90 * 24 * 60 * 60 * 1000 }])

    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.accepted).toBe(1)
    expect(storedFor(batch.events[0].externalId)).toHaveLength(1)
  })

  it("rejects a malformed event rather than storing a partial one", async () => {
    const batch = batchOf([{}])
    const response = await app.request("/v1/internal/metering/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-metering-signature": sign(batch, KEY) },
      body: JSON.stringify({ source: batch.source, events: [{ external_id: "x" }] }),
    })

    // 400, and refused before the signature is even considered — a malformed batch must not be
    // usable to probe the verifier.
    expect(response.status).toBe(400)
  })

  it("drops an event for an organization that does not exist, without a 500", async () => {
    // A pod label can name an organization that has since been deleted. Inserting anyway violates
    // the foreign key and returns a 500, which the agent retries forever — so one stale label
    // stalls that node's whole usage stream behind a batch that can never succeed. Found with a
    // real batch from a real node.
    const batch = batchOf([{ organizationId: v7() }])

    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.accepted).toBe(0)
    expect(response.json.unknownOrganizations).toBe(1)
  })

  it("keeps an event whose project does not exist, and nulls the project", async () => {
    // Different remedy on purpose. No organization means nobody to bill. An unknown *project* means
    // the organization is real and genuinely used the resource, so dropping the event would lose
    // revenue for work that was done — only the sub-attribution is unverifiable.
    const batch = batchOf([{ projectId: v7() }])

    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.accepted).toBe(1)
    expect(response.json.unknownProjects).toBe(1)

    const [stored] = storedFor(batch.events[0].externalId)

    expect(stored?.projectId).toBeNull()
    expect(stored?.resourceId).toBeNull()
    expect(stored?.organizationId).toBe(organizationId)
  })

  it("signs over a canonical form, not the bytes on the wire", async () => {
    // Reordering the JSON keys changes the bytes and not the canonical form, so the signature still
    // verifies. This is what makes the contract survive a proxy that re-serialises.
    const batch = batchOf([{}])
    const event = batch.events[0]
    const response = await app.request("/v1/internal/metering/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-metering-signature": sign(batch, KEY) },
      body: JSON.stringify({
        events: [
          {
            quantity: event.quantity,
            attributes: event.attributes,
            occurred_at: event.occurredAt,
            organization_id: event.organizationId,
            project_id: event.projectId,
            dimension: event.dimension,
            external_id: event.externalId,
          },
        ],
        source: batch.source,
      }),
    })

    expect(canonical(batch)).toContain("sproutos.metering.v1")
    expect(response.status).toBe(202)
  })

  it.skipIf(!kafkaReachable)(
    "persists through Kafka into ClickHouse and updates the Valkey projection",
    async () => {
      process.env.KAFKA_BROKERS_HOST = kafkaBroker
      const topic = process.env.KAFKA_USAGE_EVENT_TOPIC ?? "usage-events"
      const database = process.env.CLICKHOUSE_DATABASE ?? "observability"
      await clickhouse().command({ query: usageEventRawDdl(database) })
      await clickhouse().command({ query: usageEventStoredAtDdl(database) })
      await clickhouse().command({ query: usageEventDeadLetterDdl(database) })
      await clickhouse().command({ query: usageBackupManifestDdl(database) })
      // Kafka engine settings cannot be altered. Mirror the production schema upgrader before
      // asserting the poison-message-safe consumer rather than silently reusing an old table.
      await clickhouse().command({
        query: `drop view if exists ${database}.usage_event_mv`,
      })
      await clickhouse().command({
        query: `drop view if exists ${database}.usage_event_dead_letter_mv`,
      })
      await clickhouse().command({
        query: `drop table if exists ${database}.usage_event_queue sync`,
      })
      await clickhouse().command({ query: usageEventQueueDdl("kafka:9092", topic, database) })
      await clickhouse().command({ query: usageEventMaterializedViewDdl(database) })
      await clickhouse().command({ query: usageEventDeadLetterViewDdl(database) })

      // These are the two rows derived from one Lambda platform.report by the router. Keeping them
      // in the same signed batch proves that the actual site-metering pair crosses Kafka and lands
      // durably in ClickHouse, rather than proving the pipeline with an unrelated generic event.
      const batch = batchOf([
        { dimension: "site_request", quantity: 1 },
        { dimension: "site_gib_second", quantity: 0.125 },
      ])
      const active = batch.events.map((event) => ({
        eventId: usageEventId({
          source: batch.source,
          externalId: event.externalId,
          occurredAt: event.occurredAt,
        }),
        organizationId,
        projectId: null,
        dimension: event.dimension,
        quantity: event.quantity,
        occurredAt: new Date(event.occurredAt),
      }))
      const redis = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
      setMeteringSinksForTest()

      try {
        expect((await post(batch)).status).toBe(202)

        let stored: { dimension: string; quantity: string }[] = []
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const result = await clickhouse().query({
            query:
              "select dimension, toString(quantity) as quantity from usage_event_raw final " +
              "where event_id in ({eventIds:Array(String)}) order by dimension",
            query_params: { eventIds: active.map((event) => event.eventId) },
            format: "JSONEachRow",
          })
          stored = await result.json<{ dimension: string; quantity: string }>()
          if (stored.length === active.length) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        expect(stored.map((row) => [row.dimension, Number(row.quantity)])).toEqual([
          ["site_gib_second", 0.125],
          ["site_request", 1],
        ])
        expect(await Promise.all(active.map((event) => readActiveUsage(redis, event)))).toEqual([
          "1000000000",
          "125000000",
        ])
      } finally {
        setMeteringSinksForTest(testSinks)
        await closeMeteringSinks()
        const activeKeys = await redis.keys(`metering:active:v2:{${organizationId}}:*`)
        if (activeKeys.length > 0) await redis.unlink(...activeKeys)
        await redis.quit()
        await clickhouse().command({
          query: "alter table usage_event_raw delete where event_id in ({eventIds:Array(String)})",
          query_params: { eventIds: active.map((event) => event.eventId) },
          clickhouse_settings: { mutations_sync: "1" },
        })
      }
    },
    30_000,
  )
})
