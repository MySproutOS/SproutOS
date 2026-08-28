import { describe, expect, it } from "vitest"
import { cliManifestUrl, parseCliReleaseManifest } from "./cli-release"

const version = "1.2.3"
const tag = `cli-v${version}`
const prefix = `https://github.com/MySproutOS/SproutOS/releases/download/${tag}/`
const targets = [
  ["aarch64-apple-darwin", "macOS", "arm64"],
  ["x86_64-apple-darwin", "macOS", "x86-64"],
  ["aarch64-unknown-linux-gnu", "Linux", "arm64"],
  ["x86_64-unknown-linux-gnu", "Linux", "x86-64"],
  ["x86_64-pc-windows-msvc", "Windows", "x86-64"],
] as const

function manifest() {
  return {
    schemaVersion: 1,
    version,
    tag,
    assets: targets.map(([target, os, arch]) => ({
      target,
      os,
      arch,
      url: `${prefix}sprout-v${version}-${target}.tar.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 42,
    })),
  }
}

describe("the configured CLI release", () => {
  it("uses an immutable version-tag manifest URL", () => {
    expect(cliManifestUrl(version)).toBe(`${prefix}sprout-v${version}-manifest.json`)
    expect(cliManifestUrl("latest")).toBeNull()
  })

  it("accepts the exact five-target release contract", () => {
    expect(parseCliReleaseManifest(manifest(), version).assets).toHaveLength(5)
  })

  it("rejects a missing target, mutable URL, or wrong digest", () => {
    const missing = manifest()
    missing.assets.pop()
    expect(() => parseCliReleaseManifest(missing, version)).toThrow("Invalid CLI release manifest")

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
