import { db } from "@sproutos/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
} from "../test/fixtures"

const reachable = await databaseReachable()

describe.skipIf(!reachable)("runtime catalogue", () => {
  let user: TestUser

  beforeAll(async () => {
    user = await createTestUser("runtime-catalogue")
  })

  afterAll(async () => {
    await cleanupFixtures()
    await db.destroy()
  })

  it("requires authentication", async () => {
    const response = await app.request("/v1/runtimes")
    expect(response.status).toBe(401)
  })

  it("returns lifecycle metadata and only marks currently selectable ZIP runtimes selectable", async () => {
    const response = await app.request("/v1/runtimes", { headers: authHeaders(user) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<{
        id: string
        selectable: boolean
        recommended: boolean
        compatiblePresets: string[]
        deprecatedAt: string
        executionModel: string
        defaultPresets: string[]
      }>
    }

    expect(body.data.find((entry) => entry.id === "nodejs24.x")).toMatchObject({
      selectable: true,
      recommended: true,
      executionModel: "managed",
      defaultPresets: ["next", "hono", "function"],
      compatiblePresets: ["next", "hono", "web", "function"],
    })
    expect(body.data.some((entry) => entry.id === "nodejs26.x")).toBe(false)
    expect(body.data.some((entry) => entry.id === "python3.15")).toBe(false)
    expect(body.data.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.deprecatedAt))).toBe(true)
  })
})
