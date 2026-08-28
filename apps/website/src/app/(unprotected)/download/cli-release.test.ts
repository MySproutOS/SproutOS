import { describe, expect, it } from "vitest"
import { cliManifestUrl, cliPlatformLabel, parseCliReleaseManifest } from "./cli-release"

const version = "1.2.3"
const tag = `cli-v${version}`
const prefix = `https://github.com/MySproutOS/SproutOS/releases/download/${tag}/`
const targets = [
  ["aarch64-apple-darwin", "macos", "arm64", "tar.gz"],
  ["x86_64-apple-darwin", "macos", "x86_64", "tar.gz"],
  ["aarch64-unknown-linux-gnu", "linux", "arm64", "tar.gz"],
  ["x86_64-unknown-linux-gnu", "linux", "x86_64", "tar.gz"],
  ["x86_64-pc-windows-msvc", "windows", "x86_64", "zip"],
] as const

function manifest() {
  return {
    schemaVersion: 1,
    version,
    tag,
    assets: targets.map(([target, os, arch, suffix]) => ({
      target,
      os,
      arch,
      url: `${prefix}sprout-v${version}-${target}.${suffix}`,
      sha256: "a".repeat(64),
      sizeBytes: 42,
    })),
  }
}

describe("the configured CLI release", () => {
  it("uses an immutable version-tag manifest URL for canonical semantic versions", () => {
    expect(cliManifestUrl(version)).toBe(`${prefix}sprout-v${version}-manifest.json`)
    expect(cliManifestUrl("1.2.3-alpha.1+build.5")).toContain(
      "cli-v1.2.3-alpha.1+build.5/sprout-v1.2.3-alpha.1+build.5-manifest.json",
    )
    expect(cliManifestUrl("latest")).toBeNull()
    expect(cliManifestUrl("01.2.3")).toBeNull()
  })

  it("accepts the exact five-target release contract", () => {
    const parsed = parseCliReleaseManifest(manifest(), version)
    expect(parsed.assets).toHaveLength(5)
    expect(cliPlatformLabel(parsed.assets[1])).toBe("macOS x86-64")
  })

  it("rejects missing, duplicated, mislabeled, mutable, or corrupted assets", () => {
    const missing = manifest()
    missing.assets.pop()
    expect(() => parseCliReleaseManifest(missing, version)).toThrow("Invalid CLI release manifest")

    const duplicate = manifest()
    duplicate.assets[1] = duplicate.assets[0]
    expect(() => parseCliReleaseManifest(duplicate, version)).toThrow(
      "Invalid CLI release manifest",
    )

    const mislabeled = manifest()
    mislabeled.assets[0].os = "linux"
    expect(() => parseCliReleaseManifest(mislabeled, version)).toThrow(
      "Invalid CLI release manifest",
    )

    const mutable = manifest()
    mutable.assets[0].url = "https://github.com/MySproutOS/SproutOS/releases/latest/download/sprout"
    expect(() => parseCliReleaseManifest(mutable, version)).toThrow("Invalid CLI release manifest")

    const badDigest = manifest()
    badDigest.assets[0].sha256 = "not-a-digest"
    expect(() => parseCliReleaseManifest(badDigest, version)).toThrow(
      "Invalid CLI release manifest",
    )
  })
})
