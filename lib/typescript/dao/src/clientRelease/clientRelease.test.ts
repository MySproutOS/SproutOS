import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudClientRelease } from "./crud"
import { fetchClientRelease, SPROUTOS_ANDROID_PACKAGE } from "./fetch"

let reachable = false
const objectPrefix = `client/test-${Date.now()}`
const identityId = v7()

beforeAll(async () => {
  try {
    await sql`select 1 from client_release limit 1`.execute(db)
    await db
      .insertInto("clientSigningIdentity")
      .values({
        id: identityId,
        packageName: SPROUTOS_ANDROID_PACKAGE,
        state: "ready",
        keyObjectKey: "keys/client/signing.keystore.enc",
        keyObjectVersion: "dao-test",
        certificateSha256: "a".repeat(64),
        developerConsoleAccount: "developerAccounts/123",
        developerConsoleState: "registered",
        developerConsoleProviderState: "REGISTERED",
      })
      .onConflict((conflict) =>
        conflict.column("packageName").doUpdateSet({
          developerConsoleAccount: "developerAccounts/123",
          developerConsoleState: "registered",
          developerConsoleProviderState: "REGISTERED",
        }),
      )
      .execute()
    reachable = true
  } catch {
    return
  }
})

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("clientRelease").where("apkObjectKey", "like", `${objectPrefix}%`).execute()
  await db.deleteFrom("clientSigningIdentity").where("id", "=", identityId).execute()
  await db.destroy()
})

function release(versionCode: number) {
  return {
    packageName: SPROUTOS_ANDROID_PACKAGE,
    versionName: `1.0.${versionCode}`,
    versionCode,
    apkObjectKey: `${objectPrefix}/${versionCode}.apk`,
    apkObjectVersion: `version-${versionCode}`,
    apkSha256: versionCode.toString(16).padStart(64, "0"),
    apkSizeBytes: 1_024,
    certificateSha256: "a".repeat(64),
    required: false,
    verifiedAt: new Date(),
  } as const
}

describe("client releases", () => {
  it("selects the highest Android version code regardless of insert order", async ({ skip }) => {
    if (!reachable) skip()
    await crudClientRelease(db).create(release(3))
    await crudClientRelease(db).create(release(7))
    await crudClientRelease(db).create(release(5))

    const latest = await fetchClientRelease(db).latest(["versionCode", "versionName"])
    expect(latest).toEqual({ versionCode: 7, versionName: "1.0.7" })
  })

  it("cannot publish another package under the platform client contract", async ({ skip }) => {
    if (!reachable) skip()
    await expect(
      crudClientRelease(db).create({ ...release(9), packageName: "me.sproutos.customer" }),
    ).rejects.toThrow("client_release_package_name_check")
  })

  it("bounds versionCode to Android's accepted range", async ({ skip }) => {
    if (!reachable) skip()
    await expect(crudClientRelease(db).create(release(2_100_000_001))).rejects.toThrow(
      "client_release_version_code_check",
    )
  })

  it("hides existing releases immediately when registration proof is lost", async ({ skip }) => {
    if (!reachable) skip()
    await db
      .updateTable("clientSigningIdentity")
      .set({ developerConsoleState: "pending_registration" })
      .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
      .execute()
    expect(await fetchClientRelease(db).latest(["versionCode"])).toBeUndefined()
  })

  it("cannot bypass publication by writing registered without durable provider proof", async ({
    skip,
  }) => {
    if (!reachable) skip()
    await db
      .updateTable("clientSigningIdentity")
      .set({
        developerConsoleState: "pending_registration",
        developerConsoleProviderState: null,
      })
      .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
      .execute()
    await expect(
      db
        .updateTable("clientSigningIdentity")
        .set({ developerConsoleState: "registered" })
        .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
        .execute(),
    ).rejects.toThrow("client_signing_identity_registered_identity_check")
    expect(await fetchClientRelease(db).latest(["versionCode"])).toBeUndefined()
  })

  it("makes the selected developer account immutable after the first signer callback", async ({
    skip,
  }) => {
    if (!reachable) skip()
    await expect(
      db
        .updateTable("clientSigningIdentity")
        .set({ developerConsoleAccount: "developerAccounts/999" })
        .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
        .execute(),
    ).rejects.toThrow("developer_console_account is immutable once set")
  })
})
