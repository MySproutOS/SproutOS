import { describe, expect, it } from "vitest"
import {
  androidReleaseError,
  mintDeployToken,
  readDeployToken,
  releasePreviewNumber,
  staticReleaseError,
} from "./deploy"

/**
 * The deploy token is what the upload and release calls carry, so forging one is deploying to
 * somebody else's project.
 */
const SECRET = "test-secret"
const NOW = 1_800_000_000_000
const now = () => NOW
const PROJECT = "01a01e12-1700-76ac-9713-dd208babdf5a"

describe("deploy tokens", () => {
  it("round-trips the project it was minted for", () => {
    const token = mintDeployToken(PROJECT, Math.floor(NOW / 1000) + 900, SECRET)

    expect(readDeployToken(token, SECRET, now)).toEqual({ projectId: PROJECT })
  })

  it("refuses a token signed with a different secret", () => {
    // The whole point: the project id is in plain sight, so what stops anyone claiming a project is
    // that they cannot produce the MAC over it.
    const token = mintDeployToken(PROJECT, Math.floor(NOW / 1000) + 900, "some-other-secret")

    expect(readDeployToken(token, SECRET, now)).toBeUndefined()
  })

  it("refuses a token whose project was edited", () => {
    // Swapping the project id for somebody else's is the attack this exists to stop.
    const token = mintDeployToken(PROJECT, Math.floor(NOW / 1000) + 900, SECRET)
    const [, expiry, mac] = token.split(".")

    expect(readDeployToken(`01a0-victim.${expiry}.${mac}`, SECRET, now)).toBeUndefined()
  })

  it("refuses a token whose expiry was pushed out", () => {
    // The expiry is inside the MAC, so extending it invalidates the signature rather than the
    // token lasting longer.
    const token = mintDeployToken(PROJECT, Math.floor(NOW / 1000) - 1, SECRET)
    const [projectId, , mac] = token.split(".")

    expect(
      readDeployToken(`${projectId}.${Math.floor(NOW / 1000) + 9999}.${mac}`, SECRET, now),
    ).toBeUndefined()
  })

  it("refuses an expired token", () => {
    const token = mintDeployToken(PROJECT, Math.floor(NOW / 1000) - 1, SECRET)

    expect(readDeployToken(token, SECRET, now)).toBeUndefined()
  })

  it("refuses anything that is not three parts", () => {
    for (const malformed of ["", "a", "a.b", "a.b.c.d"]) {
      expect(readDeployToken(malformed, SECRET, now)).toBeUndefined()
    }
  })
})

describe("Android release identity", () => {
  const digest = "b".repeat(64)

  it("requires a monotonic version code and the raw token-bound APK key", () => {
    expect(
      androidReleaseError(PROJECT, {
        preset: "android",
        key: `raw/${PROJECT}/${digest}.apk`,
        digest,
      }),
    ).toMatch(/version_code/)
    expect(
      androidReleaseError(PROJECT, {
        preset: "android",
        key: `builds/${PROJECT}/${digest}.zip`,
        digest,
        version_code: 2,
      }),
    ).toMatch(/raw APK/)
    expect(
      androidReleaseError(PROJECT, {
        preset: "android",
        key: `raw/${PROJECT}/${digest}.apk`,
        digest,
        version_code: 2,
      }),
    ).toBeUndefined()
  })

  it("does not accept Android-only version metadata on another preset", () => {
    expect(
      androidReleaseError(PROJECT, {
        preset: "next",
        key: `builds/${PROJECT}/${digest}.zip`,
        digest,
        version_code: 2,
      }),
    ).toMatch(/only valid for Android/)
  })

  it("refuses a version code above Android's supported maximum", () => {
    expect(
      androidReleaseError(PROJECT, {
        preset: "android",
        key: `raw/${PROJECT}/${digest}.apk`,
        digest,
        version_code: 2_100_000_001,
      }),
    ).toMatch(/2100000000/)
  })
})

describe("static release identity", () => {
  const digest = "a".repeat(64)

  it("requires the archive and digest as a pair for a static preset", () => {
    expect(staticReleaseError(PROJECT, { preset: "static" })).toMatch(/requires/)
    expect(
      staticReleaseError(PROJECT, {
        preset: "static",
        static_key: `static/${PROJECT}/${digest}.zip`,
      }),
    ).toMatch(/both be set/)
  })

  it("accepts only the authenticated project's content-addressed key", () => {
    expect(
      staticReleaseError(PROJECT, {
        preset: "static",
        static_key: `static/${PROJECT}/${digest}.zip`,
        static_digest: digest,
      }),
    ).toBeUndefined()
    expect(
      staticReleaseError(PROJECT, {
        preset: "static",
        static_key: `static/somebody-else/${digest}.zip`,
        static_digest: digest,
      }),
    ).toMatch(/does not belong/)
  })
})

describe("CI preview identity", () => {
  it("derives a pull request number and refuses branch-shaped previews", () => {
    expect(releasePreviewNumber("production", "refs/heads/main")).toBeNull()
    expect(releasePreviewNumber("preview", "refs/pull/42/merge")).toBe(42)
    expect(releasePreviewNumber("preview", "refs/pull/42/head")).toBe(42)
    expect(releasePreviewNumber("preview", "42/merge")).toBe(42)
    expect(releasePreviewNumber("preview", "refs/heads/feature")).toBeUndefined()
  })
})
