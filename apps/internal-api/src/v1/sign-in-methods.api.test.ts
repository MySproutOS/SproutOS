import { db } from "@sproutos/db"
import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import { v7 } from "uuid"
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
let owner: TestUser | undefined

describe.runIf(reachable)("user-scoped sign-in method API", () => {
  beforeAll(async () => {
    owner = await createTestUser("sign-in-methods")
    await db
      .insertInto("account")
      .values({
        id: v7(),
        userId: owner.id,
        provider: "github",
        providerAccountId: `github-${v7()}`,
        type: "oauth",
        displayIdentity: "safe-handle",
        accessTokenCiphertext: "secret-ciphertext",
        accessTokenWrappedDek: "secret-wrapped-key",
        accessTokenKmsKeyId: "secret-kms-key",
      })
      .execute()
  })

  afterAll(async () => {
    await cleanupFixtures()
    await db.destroy()
  })

  it("requires authentication and returns no provider ids or token material", async () => {
    expect((await app.request("/v1/user/sign-in-methods")).status).toBe(401)

    const response = await app.request("/v1/user/sign-in-methods", {
      headers: authHeaders(owner!),
    })
    expect(response.status).toBe(200)
    const body = JSON.stringify(await response.json())
    expect(body).toContain("safe-handle")
    expect(body).not.toContain("github-")
    expect(body).not.toContain("secret-")
  })

  it("refuses mutations without recent reauthentication and protects the final identity", async () => {
    const method = await db
      .selectFrom("account")
      .select("id")
      .where("userId", "=", owner!.id)
      .executeTakeFirstOrThrow()

    const stale = await app.request(`/v1/user/sign-in-methods/${method.id}`, {
      method: "DELETE",
      headers: authHeaders(owner!),
      body: JSON.stringify({ confirmation: "UNLINK" }),
    })
    expect(stale.status).toBe(403)

    await db
      .updateTable("session")
      .set({ reauthenticatedAt: new Date() })
      .where("sessionKey", "=", encodeHexLowerCase(await sha256Utf8(owner!.sessionToken)))
      .execute()
    const last = await app.request(`/v1/user/sign-in-methods/${method.id}`, {
      method: "DELETE",
      headers: authHeaders(owner!),
      body: JSON.stringify({ confirmation: "UNLINK" }),
    })
    expect(last.status).toBe(409)
    expect(JSON.stringify(await last.json())).toContain("Link another sign-in method")
  })

  it("never exposes platform policy administration to an ordinary user", async () => {
    const response = await app.request("/admin/managed-domain-policies", {
      headers: authHeaders(owner!),
    })
    expect(response.status).toBe(403)
  })
})
