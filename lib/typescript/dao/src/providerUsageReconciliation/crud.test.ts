import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudProviderUsageReconciliation } from "./crud"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

afterAll(async () => {
  await db.destroy()
})

describe.skipIf(!reachable)("provider usage reconciliation DAO", () => {
  it("replaces a corrected provider day instead of accumulating it", async ({ skip }) => {
    if (!reachable) skip()
    const resourceId = `test-${v7()}`
    const periodStart = new Date("2099-01-02T00:00:00.000Z")
    const observedAt = new Date("2099-01-05T00:00:00.000Z")
    const crud = crudProviderUsageReconciliation(db)
    await crud.upsert({
      id: v7(),
      provider: "cloudfront",
      resourceId,
      periodStart,
      providerRequests: "10",
      providerEgressBytes: "100",
      importedRequests: "8",
      importedEgressBytes: "80",
      residualRequests: "2",
      residualEgressBytes: "20",
      status: "platform_overhead",
      observedAt,
    })
    await crud.upsert({
      id: v7(),
      provider: "cloudfront",
      resourceId,
      periodStart,
      providerRequests: "10",
      providerEgressBytes: "100",
      importedRequests: "10",
      importedEgressBytes: "100",
      residualRequests: "0",
      residualEgressBytes: "0",
      status: "matched",
      observedAt: new Date("2099-01-06T00:00:00.000Z"),
    })

    const rows = await db
      .selectFrom("providerUsageReconciliation")
      .select(["importedRequests", "residualRequests", "status"])
      .where("provider", "=", "cloudfront")
      .where("resourceId", "=", resourceId)
      .where("periodStart", "=", periodStart)
      .execute()

    expect(rows).toEqual([
      { importedRequests: "10.000000000", residualRequests: "0.000000000", status: "matched" },
    ])
    await db
      .deleteFrom("providerUsageReconciliation")
      .where("resourceId", "=", resourceId)
      .execute()
  })
})
