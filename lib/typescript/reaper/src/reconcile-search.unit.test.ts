import { describe, expect, it } from "vitest"
import { deriveSearchSecurityPassword } from "./reconcile-search"

describe("search Security credential derivation", () => {
  it("matches the Rust search-proxy vector", () => {
    expect(
      deriveSearchSecurityPassword(
        "0123456789abcdef0123456789abcdef",
        "ix_00000000000000000000000001.00000000000000000000000000",
      ),
    ).toBe("cg4vg1275ggawkhs73n4p41eskvy8180w9xsg45f85vpxrgfqza0")
  })
})
