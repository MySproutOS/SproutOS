import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { crudClientRelease } from "./crud"
import { fetchClientRelease, SPROUTOS_ANDROID_PACKAGE } from "./fetch"

let reachable = false
const objectPrefix = `client/test-${Date.now()}`

beforeAll(async () => {
  try {
    await sql`select 1 from client_release limit 1`.execute(db)
    reachable = true
  } catch {
    return
  }
})

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("clientRelease").where("apkObjectKey", "like", `${objectPrefix}%`).execute()
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
})
