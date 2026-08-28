import { afterEach, describe, expect, it, vi } from "vitest"
import { waitForProjectLock, withLeaseHeartbeat } from "./project-lock"

afterEach(() => vi.useRealTimers())

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

  it("renews the queue lease while acquired project work is still running", async () => {
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    const blockedWork = new Promise<void>((resolve) => {
      finish = resolve
    })
    let heartbeats = 0
    const running = withLeaseHeartbeat(
      () => blockedWork,
      () => {
        heartbeats += 1
        return Promise.resolve(true)
      },
      1_000,
    )

    await vi.advanceTimersByTimeAsync(3_000)
    expect(heartbeats).toBe(3)
    finish?.()
    await running
  })
})
