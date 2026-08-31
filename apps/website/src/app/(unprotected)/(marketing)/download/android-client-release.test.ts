import { afterEach, describe, expect, it } from "vitest"
import { latestAndroidClientRelease, parseAndroidClientRelease } from "./android-client-release"

const release = {
  packageName: "com.sproutos.store",
  versionName: "1.2.3",
  versionCode: 123,
  sha256: "a".repeat(64),
  sizeBytes: 42,
  certificateSha256: "b".repeat(64),
  downloadUrl: "https://artifacts.example/sproutos.apk?signature=one",
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_URL
})

describe("the Android client release consumer", () => {
  it("reads the canonical production-facing API route", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.sproutos.me"
    const seen: string[] = []
    const result = await latestAndroidClientRelease((input) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(Response.json(release))
    })

    expect(seen).toEqual(["https://api.sproutos.me/v1/android/client-release"])
    expect(result).toEqual(release)
  })

  it("treats the absence of a published release as an expected state", async () => {
    const result = await latestAndroidClientRelease(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    )
    expect(result).toBeNull()
  })

  it("does not turn API failures into a false no-release message", async () => {
    await expect(
      latestAndroidClientRelease(() => Promise.resolve(new Response(null, { status: 503 }))),
    ).rejects.toThrow("status 503")
  })

  it("refuses metadata that cannot safely drive an APK install", () => {
    expect(() =>
      parseAndroidClientRelease({ ...release, packageName: "me.sproutos.fake" }),
    ).toThrow("Invalid Android client release")
    expect(() => parseAndroidClientRelease({ ...release, sha256: "A".repeat(64) })).toThrow(
      "Invalid Android client release",
    )
    expect(() =>
      parseAndroidClientRelease({ ...release, downloadUrl: "http://artifacts.example" }),
    ).toThrow("Invalid Android client release")
  })
})
