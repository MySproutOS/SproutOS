import { describe, expect, it } from "vitest"
import { orchestrateCatalogueTemplate } from "./catalogue-template"

describe("catalogue template lifecycle", () => {
  it("provisions services before forking and applies core before deployment", async () => {
    const events: string[] = []
    const repository = await orchestrateCatalogueTemplate({
      transition: (state) => {
        events.push(`state:${state}`)
        return Promise.resolve()
      },
      configure: () => {
        events.push("configure")
        return Promise.resolve()
      },
      provisionServices: () => {
        events.push("services")
        return Promise.resolve()
      },
      fork: () => {
        events.push("fork")
        return Promise.resolve({ id: 42 })
      },
      prepareAndPush: ({ id }) => {
        events.push(`core:${id}`)
        return Promise.resolve()
      },
    })

    expect(repository).toEqual({ id: 42 })
    expect(events).toEqual([
      "state:configuring",
      "configure",
      "state:provisioning",
      "services",
      "state:forking",
      "fork",
      "state:preparing",
      "core:42",
      "state:deploying",
    ])
  })

  it("does not fork when service provisioning fails", async () => {
    const events: string[] = []
    await expect(
      orchestrateCatalogueTemplate({
        transition: (state) => {
          events.push(`state:${state}`)
          return Promise.resolve()
        },
        configure: () => Promise.resolve(),
        provisionServices: () => Promise.reject(new Error("database unavailable")),
        fork: () => {
          events.push("fork")
          return Promise.resolve(null)
        },
        prepareAndPush: () => Promise.resolve(),
      }),
    ).rejects.toThrow("database unavailable")
    expect(events).not.toContain("fork")
  })
})
