import { describe, expect, it } from "vitest"
import { waitForProjectLock } from "./project-lock"

describe("project lock lease heartbeat", () => {
  it("keeps the queue lease alive for every blocked lock retry", async () => {
    let attempts = 0
    let heartbeats = 0
    await waitForProjectLock(
      "project-1",
      () => {
        attempts += 1
        return Promise.resolve(attempts === 3)
      },
      {
        keepAlive: () => {
          heartbeats += 1
          return Promise.resolve(true)
        },
        waitBeforeRetry: () => Promise.resolve(),
      },
    )

    expect(attempts).toBe(3)
    expect(heartbeats).toBe(2)
  })
})
