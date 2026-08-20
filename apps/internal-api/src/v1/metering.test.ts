import { canonical, sign, type UsageBatch } from "@lib/metering"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()

const KEY = "test-metering-key"
let organizationId: string

function batchOf(events: Partial<UsageBatch["events"][number]>[]): UsageBatch {
  return {
    source: "node-under-test",
    events: events.map((event, index) => ({
      externalId: `e-${v7()}-${index}`,
      organizationId,
      projectId: null,
      dimension: "site_vcpu_second",
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
        dimension: event.dimension,
        quantity: event.quantity,
        occurred_at: event.occurredAt,
        attributes: event.attributes,
      })),
    }),
  })

  const text = await response.text()
  return {
    status: response.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  }
}

async function storedFor(externalId: string) {
  return await db
    .selectFrom("usageEvent")
    .select(["organizationId", "dimension", "quantity", "nodeId", "source"])
    .where("externalId", "=", externalId)
    .execute()
}

beforeAll(async () => {
  process.env.METERING_INGEST_HMAC_KEY = KEY
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
  await db.deleteFrom("usageEvent").where("source", "=", "node-under-test").execute()
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!reachable)("metering ingest", () => {
  it("stores a signed batch", async () => {
    const batch = batchOf([{}])
    const response = await post(batch)

    expect(response.status).toBe(202)
    expect(response.json.accepted).toBe(1)

    const [stored] = await storedFor(batch.events[0].externalId)
    expect(stored?.organizationId).toBe(organizationId)
    expect(stored?.dimension).toBe("site_vcpu_second")
    // `numeric(38,9)` comes back as a string; the value has to survive the round trip exactly.
    expect(Number(stored?.quantity)).toBeCloseTo(0.25, 9)
    expect(stored?.nodeId).toBe("node-under-test")
  })

  it("refuses a batch whose quantity was altered after signing", async () => {
    // The entire point of signing. A proxy or a compromised node that inflates a number must not be
    // able to bill for it.
    const batch = batchOf([{}])
    const signature = sign(batch, KEY)
    const tampered = { ...batch, events: [{ ...batch.events[0], quantity: 9999 }] }

    const response = await post(tampered, signature)

    expect(response.status).toBe(401)
    expect(await storedFor(tampered.events[0].externalId)).toHaveLength(0)
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

  it("does not bill twice for a replayed batch", async () => {
    // The agent retries a batch it could not confirm, so the same events arrive again. Unique on
    // (source, external_id, occurred_at).
    const batch = batchOf([{}])

    expect((await post(batch)).status).toBe(202)
    expect((await post(batch)).status).toBe(202)

    expect(await storedFor(batch.events[0].externalId)).toHaveLength(1)
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
})
