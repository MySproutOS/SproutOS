import { describe, expect, it } from "vitest"

import { artifactNameFor } from "./loader.cjs"

describe("sprout-node native loader", () => {
  it("loads the production GNU arm64 artifact by an exact name", () => {
    expect(artifactNameFor("linux", "arm64", true)).toBe("sprout-node.linux-arm64-gnu.node")
  })

  it.each([
    ["linux", "arm64", false],
    ["linux", "x64", true],
    ["win32", "x64", true],
  ] as const)(
    "fails closed for %s/%s instead of loading a neighboring ABI",
    (platform, arch, glibc) => {
      expect(() => artifactNameFor(platform, arch, glibc)).toThrow(/no verified native artifact/)
    },
  )
})
