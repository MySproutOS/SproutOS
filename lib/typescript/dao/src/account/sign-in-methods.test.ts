import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { crudAccount } from "./crud"
import { fetchAccount } from "./fetch"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

describe.runIf(reachable)("sign-in method DAO", () => {
  const userId = v7()
  const googleId = v7()
  const githubId = v7()

  beforeAll(async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.test` })
      .execute()
    await db
      .insertInto("account")
      .values([
        {
          id: googleId,
          userId,
          provider: "google",
          providerAccountId: `google-${userId}`,
          type: "oauth",
          displayIdentity: `${userId}@gmail.test`,
        },
        {
          id: githubId,
          userId,
          provider: "github",
          providerAccountId: "424242",
          type: "oauth",
          displayIdentity: "renamed-handle",
          accessTokenCiphertext: "ciphertext-not-for-listing",
          accessTokenWrappedDek: "wrapped-key-not-for-listing",
          accessTokenKmsKeyId: "kms-key-not-for-listing",
          scopes: ["read:user"],
        },
      ])
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("user").where("id", "=", userId).execute()
    await db.destroy()
  })

  it("lists safe identity fields and never materializes credentials", async () => {
    const methods = await fetchAccount(db).listSignInMethods(userId)
    expect(methods).toHaveLength(2)
    expect(methods).toContainEqual(
      expect.objectContaining({
        id: githubId,
        provider: "github",
        displayIdentity: "renamed-handle",
      }),
    )
    expect(Object.keys(methods[0] ?? {})).not.toContain("providerAccountId")
    expect(JSON.stringify(methods)).not.toContain("ciphertext-not-for-listing")
    expect(JSON.stringify(methods)).not.toContain("wrapped-key-not-for-listing")
  })

  it("finds conflicts by stable provider identity and enforces the last-method count", async () => {
    expect(await fetchAccount(db).findByProviderIdentity("github", "424242", ["userId"])).toEqual({
      userId,
    })
    expect(await fetchAccount(db).countSignInMethods(userId)).toBe(2)
    expect(await crudAccount(db).deleteAccount(googleId, userId)).toBe(true)
    expect(await fetchAccount(db).countSignInMethods(userId)).toBe(1)
  })
})
