import { describe, expect, it, vi } from "vitest"
import { postgresTeardownDriver } from "./teardown"

describe("Postgres teardown provider selection", () => {
  it("uses the recorded Neon driver without constructing the shared-cluster driver", () => {
    const neon = { provider: "neon" }
    const sprout = vi.fn<() => { provider: string }>(() => ({ provider: "sprout" }))

    expect(
      postgresTeardownDriver("neon", "service-1", {
        neon: () => neon,
        sprout,
      }),
    ).toBe(neon)
    expect(sprout).not.toHaveBeenCalled()
  })

  it("uses the recorded shared-cluster driver for legacy Sprout databases", () => {
    const sprout = { provider: "sprout" }
    const neon = vi.fn<() => { provider: string }>(() => ({ provider: "neon" }))

    expect(
      postgresTeardownDriver("sprout", "service-2", {
        neon,
        sprout: () => sprout,
      }),
    ).toBe(sprout)
    expect(neon).not.toHaveBeenCalled()
  })

  it("refuses an unknown provider instead of guessing from DATABASE_URL", () => {
    const neon = vi.fn<() => undefined>()
    const sprout = vi.fn<() => undefined>()

    expect(() => {
      postgresTeardownDriver("byo", "service-3", { neon, sprout })
    }).toThrow('Postgres service service-3 uses unsupported provider "byo"')
    expect(neon).not.toHaveBeenCalled()
    expect(sprout).not.toHaveBeenCalled()
  })
})
