/* oxlint-disable no-await-in-loop */
import { overhead, rateTimesQuantity } from "@lib/billing/money"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * The usage and statement views.
 *
 * The arithmetic is what is worth testing: unit conversion is where a bill goes wrong by three
 * orders of magnitude, and the grain filter is where it goes wrong by a factor of three.
 */
const up = await databaseReachable()

type Json = Record<string, unknown>

const NO_WRITER_DIMENSIONS = ["site_provisioned_gib_second"] as const

async function call(
  method: string,
  path: string,
  user: TestUser,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, { method, headers: authHeaders(user) })
  return { status: response.status, json: (await response.json()) as Json }
}

let user: TestUser | undefined
let orgSlug = ""
let organizationId = ""
const rollupIds: string[] = []
const statementIds: string[] = []

function actor(): TestUser {
  if (user === undefined) throw new Error("the fixture was not built")
  return user
}

async function meter(
  dimension: string,
  quantity: string,
  bucket = "day",
  externallyChargedQuantity = "0",
): Promise<string> {
  const id = v7()
  await db
    .insertInto("usageRollup")
    .values({
      id,
      organizationId,
      dimension,
      bucket,
      bucketStart: new Date(),
      quantity,
      externallyChargedQuantity,
      chargedQuantity: externallyChargedQuantity,
    })
    .execute()
  rollupIds.push(id)
  return id
}

beforeAll(async () => {
  if (!up) return
  user = await createTestUser("usage")
  const created = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: `Usage Suite ${v7()}` }),
  })
  const organization = (await created.json()) as Json
  organizationId = organization.id as string
  orgSlug = organization.slug as string
  trackOrganization(organizationId)
})

afterAll(async () => {
  if (!up) return
  if (rollupIds.length > 0) {
    await db.deleteFrom("usageRollup").where("id", "in", rollupIds).execute()
  }
  if (statementIds.length > 0) {
    await db.deleteFrom("statement").where("id", "in", statementIds).execute()
  }
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("usage this period", () => {
  it("reports nothing for an organization that has used nothing", async ({ skip }) => {
    if (!up) skip()
    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    expect(response.status).toBe(200)
    expect(response.json.lines).toEqual([])
    expect(response.json.totalMicroUsd).toBe("0")
    // Zero burn, not a division by zero. A fresh organization opens this page.
    expect(response.json.burnPerDayMicroUsd).toBe("0")
  })

  it("keeps dimensions with no writer absent rather than presenting invented zeroes", async ({
    skip,
  }) => {
    if (!up) skip()
    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const lines = response.json.lines as Json[]

    for (const dimension of NO_WRITER_DIMENSIONS) {
      expect(lines.find((line) => line.dimension === dimension)).toBeUndefined()
    }
  })

  it("does not price unsupported WebSocket usage", async ({ skip }) => {
    if (!up) skip()
    const priced = await db
      .selectFrom("priceBookItem")
      .select("priceBookId")
      .where("dimension", "=", "site_ws_connection_second")
      .executeTakeFirst()
    expect(priced).toBeUndefined()
  })

  it("rates a dimension against the price book and adds overhead", async ({ skip }) => {
    if (!up) skip()
    await meter("site_request", "1000000")

    const book = await db
      .selectFrom("priceBook")
      .select(["id", "overheadBps"])
      .orderBy("effectiveAt", "desc")
      .executeTakeFirstOrThrow()
    const item = await db
      .selectFrom("priceBookItem")
      .select("unitMicroUsd")
      .where("priceBookId", "=", book.id)
      .where("dimension", "=", "site_request")
      .executeTakeFirstOrThrow()

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const expectedUsage = rateTimesQuantity(String(item.unitMicroUsd), "1000000")
    const expectedOverhead = overhead(expectedUsage, book.overheadBps)

    expect(response.json.subtotalMicroUsd).toBe(expectedUsage.toString())
    expect(response.json.overheadMicroUsd).toBe(expectedOverhead.toString())
    // A statement has to be explicable as usage plus overhead, and this is the identity that says
    // so — the same one `@lib/billing`'s README promises.
    expect(BigInt(response.json.totalMicroUsd as string)).toBe(expectedUsage + expectedOverhead)
  })

  it("shows BYO AI usage without presenting it as a SproutOS charge", async ({ skip }) => {
    if (!up) skip()
    await meter("ai_input_token", "12345", "day", "12345")

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const line = (response.json.lines as Json[]).find((row) => row.dimension === "ai_input_token")

    expect(line).toMatchObject({
      label: "AI input",
      quantity: "12345",
      unit: "tokens",
      amountMicroUsd: "0",
    })
  })

  it("adds sandbox provider cost without increasing platform overhead", async ({ skip }) => {
    if (!up) skip()
    const before = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())

    await meter("sandbox_cpu_second", "3600")

    const after = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    expect(
      BigInt(after.json.subtotalMicroUsd as string) -
        BigInt(before.json.subtotalMicroUsd as string),
    ).toBe(rateTimesQuantity("14", "3600"))
    expect(after.json.overheadMicroUsd).toBe(before.json.overheadMicroUsd)
  })

  it("keeps agent duration out of customer cost lines", async ({ skip }) => {
    if (!up) skip()
    const before = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    await meter("agent_run_second", "3600")
    const after = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())

    expect((after.json.lines as Json[]).some((line) => line.dimension === "agent_run_second")).toBe(
      false,
    )
    expect(after.json.totalMicroUsd).toBe(before.json.totalMicroUsd)
  })

  it("applies 2% only to Postgres compute and 0% to Postgres storage", async ({ skip }) => {
    if (!up) skip()
    const before = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    await meter("db_compute_cu_second", "3600")
    const afterCompute = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())

    const compute = rateTimesQuantity("29.444444444", "3600")
    expect(
      BigInt(afterCompute.json.overheadMicroUsd as string) -
        BigInt(before.json.overheadMicroUsd as string),
    ).toBe(overhead(compute, 200))

    await meter("db_storage_gib_hour", "730")
    const afterStorage = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    expect(afterStorage.json.overheadMicroUsd).toBe(afterCompute.json.overheadMicroUsd)
  })

  it("counts each rollup grain once", async ({ skip }) => {
    if (!up) skip()
    /*
      The same usage is rolled up at minute, hour *and* day grain. Summing across buckets shows a
      customer three times what they used, which is the kind of bug they notice before we do.
    */
    const before = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const baseline = BigInt(before.json.totalMicroUsd as string)

    await meter("site_request", "500000", "minute")
    await meter("site_request", "500000", "hour")

    const after = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    expect(BigInt(after.json.totalMicroUsd as string)).toBe(baseline)
  })

  it("shows seconds as hours, not as seconds", async ({ skip }) => {
    if (!up) skip()
    // 7200 vCPU-seconds is 2 vCPU-hours. Showing "7200" would have a customer reconciling against
    // a number in a unit nothing else on their bill uses.
    await meter("site_gib_second", "7200")

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const line = (response.json.lines as Json[]).find((row) => row.dimension === "site_gib_second")
    expect(line?.quantity).toBe("2")
    expect(line?.unit).toBe("GB-hours")
    expect(line?.label).toBe("Compute")
  })

  it("converts GiB-hours to GiB-months", async ({ skip }) => {
    if (!up) skip()
    /*
      730 hours to the month. Metered per hour and read per month, which is the single easiest place
      to be wrong by three orders of magnitude — and the direction of that error is charging a
      customer 730 times what they owe, or a 730th.
    */
    const before = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const beforeLine = (before.json.lines as Json[]).find(
      (row) => row.dimension === "db_storage_gib_hour",
    )
    await meter("db_storage_gib_hour", "1460")

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const line = (response.json.lines as Json[]).find(
      (row) => row.dimension === "db_storage_gib_hour",
    )
    expect(Number(line?.quantity) - Number(beforeLine?.quantity ?? 0)).toBe(2)
    expect(line?.unit).toBe("GiB-months")
  })

  it("keeps a quantity that does not fit a JavaScript number", async ({ skip }) => {
    if (!up) skip()
    // A 1 MB payload in a queue for a day is 8.6e10 byte-seconds; a busy month runs far past 2^53.
    await meter("valkey_queue_byte_second", "123456789012345678")

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const line = (response.json.lines as Json[]).find(
      (row) => row.dimension === "valkey_queue_byte_second",
    )
    // The amount, at least, must be exact: it is money.
    expect(line?.amountMicroUsd).toMatch(/^\d+$/)
    expect(typeof line?.quantity).toBe("string")
  })

  it("lists the most expensive line first", async ({ skip }) => {
    if (!up) skip()
    // A usage list is read to find out where the money went.
    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/usage`, actor())
    const amounts = (response.json.lines as Json[]).map((row) =>
      BigInt(row.amountMicroUsd as string),
    )
    const sorted = [...amounts].sort((a, b) => (b > a ? 1 : -1))
    expect(amounts).toEqual(sorted)
  })

  it("hides another organization's usage", async ({ skip }) => {
    if (!up) skip()
    const stranger = await createTestUser("usage-outsider")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(stranger),
      body: JSON.stringify({ name: `Usage Outsider ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    trackOrganization(organization.id as string)

    const response = await call(
      "GET",
      `/v1/orgs/${organization.slug as string}/billing/usage`,
      stranger,
    )
    expect(response.json.lines).toEqual([])
    expect(response.json.totalMicroUsd).toBe("0")
  })
})

describe.skipIf(!up)("statements", () => {
  it("is empty before any period has closed", async ({ skip }) => {
    if (!up) skip()
    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/statements`, actor())
    expect(response.status).toBe(200)
    expect(response.json.data).toEqual([])
  })

  it("returns statements newest first, and omits voided ones", async ({ skip }) => {
    if (!up) skip()
    const periods = [
      { month: 5, status: "finalized" },
      { month: 6, status: "finalized" },
      { month: 7, status: "void" },
      { month: 8, status: "draft" },
    ]

    for (const period of periods) {
      const id = v7()
      await db
        .insertInto("statement")
        .values({
          id,
          organizationId,
          periodStart: new Date(Date.UTC(2026, period.month, 1)),
          periodEnd: new Date(Date.UTC(2026, period.month + 1, 1)),
          subtotalMicroUsd: 1_000_000n,
          overheadMicroUsd: 120_000n,
          totalMicroUsd: 1_120_000n,
          status: period.status,
        })
        .execute()
      statementIds.push(id)
    }

    const response = await call("GET", `/v1/orgs/${orgSlug}/billing/statements`, actor())
    const rows = response.json.data as Json[]

    // A voided statement is a correction, not history to reconcile against.
    expect(rows).toHaveLength(3)
    const starts = rows.map((row) => new Date(row.periodStart as string).getTime())
    expect(starts).toEqual([...starts].sort((a, b) => b - a))

    /*
      The draft for the month in progress is included. Hiding it until it is finalized means the
      billing page shows nothing for the period a customer is actually spending in.
    */
    expect(rows.some((row) => row.status === "draft")).toBe(true)

    // Every statement has to be explicable as subtotal plus overhead.
    for (const row of rows) {
      expect(BigInt(row.totalMicroUsd as string)).toBe(
        BigInt(row.subtotalMicroUsd as string) + BigInt(row.overheadMicroUsd as string),
      )
    }
  })
})
