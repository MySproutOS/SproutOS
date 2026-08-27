import { describe, expect, it } from "vitest"
import { deleteSnapshotAndWait, obsoleteManagedSnapshots } from "./snapshot-lifecycle"

describe("obsoleteManagedSnapshots", () => {
  it("keeps the configured base and ignores snapshots this repository does not own", () => {
    const snapshots = [
      { id: "old", name: "sproutos-agent-old" },
      { id: "current-id", name: "sproutos-agent-current" },
      { id: "system", name: "daytona-small" },
      { id: "other", name: "another-product" },
    ]

    expect(obsoleteManagedSnapshots(snapshots, "current-id")).toEqual([
      { id: "old", name: "sproutos-agent-old" },
    ])
    expect(obsoleteManagedSnapshots(snapshots, "sproutos-agent-current")).toEqual([
      { id: "old", name: "sproutos-agent-old" },
    ])
  })

  it("never selects a base referenced by a live sandbox", () => {
    const snapshots = [
      { id: "current-id", name: "sproutos-agent-current" },
      { id: "old-id", name: "sproutos-agent-old" },
      { id: "older-id", name: "sproutos-agent-older" },
    ]

    expect(
      obsoleteManagedSnapshots(
        snapshots,
        "current-id",
        new Set(["sproutos-agent-old", "older-id"]),
      ),
    ).toEqual([])
  })
})

describe("deleteSnapshotAndWait", () => {
  it("waits for the provider read to stop finding the snapshot", async () => {
    const observations = [true, true, false]
    const calls: string[] = []
    let now = 0
    await deleteSnapshotAndWait(
      () => {
        calls.push("delete")
        return Promise.resolve()
      },
      () => Promise.resolve(observations.shift()!),
      (milliseconds) => {
        calls.push("wait")
        now += milliseconds
        return Promise.resolve()
      },
      () => now,
    )
    expect(calls).toEqual(["delete", "wait", "wait"])
  })
})
