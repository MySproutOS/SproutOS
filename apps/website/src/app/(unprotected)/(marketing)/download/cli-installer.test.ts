import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import type { CliReleaseManifest } from "./cli-release"
import { renderCliInstaller } from "./cli-installer"

const version = "1.2.3"
const digest = "a".repeat(64)
const targets = [
  ["aarch64-apple-darwin", "macos", "arm64", "tar.gz"],
  ["x86_64-apple-darwin", "macos", "x86_64", "tar.gz"],
  ["aarch64-unknown-linux-gnu", "linux", "arm64", "tar.gz"],
  ["x86_64-unknown-linux-gnu", "linux", "x86_64", "tar.gz"],
  ["x86_64-pc-windows-msvc", "windows", "x86_64", "zip"],
] as const

function release(): CliReleaseManifest {
  return {
    schemaVersion: 1,
    version,
    tag: `cli-v${version}`,
    assets: targets.map(([target, os, arch, suffix]) => ({
      target,
      os,
      arch,
      url:
        `https://github.com/MySproutOS/SproutOS/releases/download/cli-v${version}/` +
        `sprout-v${version}-${target}.${suffix}`,
      sha256: digest,
      sizeBytes: 42,
    })),
  }
}

describe("the promoted CLI installer", () => {
  it("selects every supported Unix build and embeds its immutable digest", () => {
    const script = renderCliInstaller(release())
    for (const [target] of targets.slice(0, 4)) {
      expect(script).toContain(`target='${target}'`)
      expect(script).toContain(`sprout-v${version}-${target}.tar.gz`)
    }
    expect(script).toContain(`expected='${digest}'`)
    expect(script).not.toContain("releases/latest")
    expect(script).not.toContain("sudo")
  })

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n"], {
      input: renderCliInstaller(release()),
      encoding: "utf8",
    })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })
})
