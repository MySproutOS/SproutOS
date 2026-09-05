import { beforeEach, describe, expect, it, vi } from "vitest"

import { latestCliRelease } from "../(unprotected)/(marketing)/download/cli-release"
import { GET } from "./route"

vi.mock("../(unprotected)/(marketing)/download/cli-release", () => ({
  latestCliRelease: vi.fn<() => ReturnType<typeof latestCliRelease>>(),
}))

const mockedLatestCliRelease = vi.mocked(latestCliRelease)

describe("GET /install.sh", () => {
  beforeEach(() => {
    mockedLatestCliRelease.mockReset()
  })

  it("serves a checksum-pinned installer for the promoted release", async () => {
    mockedLatestCliRelease.mockResolvedValue({
      schemaVersion: 1,
      version: "0.3.0",
      tag: "cli-v0.3.0",
      assets: [
        ["aarch64-apple-darwin", "macos", "arm64", "tar.gz"],
        ["x86_64-apple-darwin", "macos", "x86_64", "tar.gz"],
        ["aarch64-unknown-linux-gnu", "linux", "arm64", "tar.gz"],
        ["x86_64-unknown-linux-gnu", "linux", "x86_64", "tar.gz"],
        ["x86_64-pc-windows-msvc", "windows", "x86_64", "zip"],
      ].map(([target, os, arch, suffix], index) => ({
        target,
        os,
        arch,
        url: `https://github.com/MySproutOS/SproutOS/releases/download/cli-v0.3.0/sprout-v0.3.0-${target}.${suffix}`,
        sha256: String(index).repeat(64),
        sizeBytes: 100 + index,
      })),
    } as Awaited<ReturnType<typeof latestCliRelease>>)

    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("version='0.3.0'")
  })

  it("fails closed when no release is promoted", async () => {
    mockedLatestCliRelease.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(503)
  })

  it("fails closed when release lookup fails", async () => {
    mockedLatestCliRelease.mockRejectedValue(new Error("unavailable"))
    const response = await GET()
    expect(response.status).toBe(503)
  })
})
