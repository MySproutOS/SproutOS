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

const reachable = await databaseReachable()
let admin: TestUser | undefined
let organizationId = ""
let policyId = ""

describe.runIf(reachable)("managed-domain policy admin API", () => {
  beforeAll(async () => {
    admin = await createTestUser("managed-domain-admin")
    await db.updateTable("user").set({ isAdmin: true }).where("id", "=", admin.id).execute()
    organizationId = trackOrganization(v7())
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        slug: `managed-${organizationId}`,
        name: "Managed domains",
        kind: "personal",
        ownerUserId: admin.id,
      })
      .execute()
  })

  afterAll(async () => {
    if (policyId !== "") {
      await db.deleteFrom("managedCustomDomainPolicy").where("id", "=", policyId).execute()
    }
    await cleanupFixtures()
    await db.destroy()
  })

  it("normalizes and creates an exact organization-bound suffix", async () => {
    const response = await app.request("/admin/managed-domain-policies", {
      method: "POST",
      headers: authHeaders(admin!),
      body: JSON.stringify({ suffix: "SPROUTOS.BIZ.", organizationId }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; suffix: string; organizationId: string }
    policyId = body.id
    expect(body).toMatchObject({ suffix: "sproutos.biz", organizationId })
  })

  it("enforces suffix uniqueness and ASCII normalization", async () => {
    const duplicate = await app.request("/admin/managed-domain-policies", {
      method: "POST",
      headers: authHeaders(admin!),
      body: JSON.stringify({ suffix: "sproutos.biz", organizationId }),
    })
    expect(duplicate.status).toBe(409)

    const unicode = await app.request("/admin/managed-domain-policies", {
      method: "POST",
      headers: authHeaders(admin!),
      body: JSON.stringify({ suffix: "spröutos.biz", organizationId }),
    })
    expect(unicode.status).toBe(400)
  })

  it("soft-disables and soft-deletes through audited admin-only operations", async () => {
    const disabled = await app.request(`/admin/managed-domain-policies/${policyId}`, {
      method: "PATCH",
      headers: authHeaders(admin!),
      body: JSON.stringify({ status: "disabled" }),
    })
    expect(disabled.status).toBe(200)
    expect((await disabled.json()) as object).toMatchObject({ status: "disabled" })

    const deleted = await app.request(`/admin/managed-domain-policies/${policyId}`, {
      method: "DELETE",
      headers: authHeaders(admin!),
    })
    expect(deleted.status).toBe(204)
    const deletedRow = await db
      .selectFrom("managedCustomDomainPolicy")
      .select("deletedAt")
      .where("id", "=", policyId)
      .executeTakeFirstOrThrow()
    expect(deletedRow.deletedAt).toBeInstanceOf(Date)
  })
})
