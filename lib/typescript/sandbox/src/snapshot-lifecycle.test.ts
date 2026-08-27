import { describe, expect, it } from "vitest"
import { obsoleteManagedSnapshots } from "./snapshot-lifecycle"

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
