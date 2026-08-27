import { describe, expect, it } from "vitest"
import { migrationResumeAction } from "./publish"

describe("migration release retry boundary", () => {
  it("never re-runs a migration whose first attempt may have started", () => {
    expect(migrationResumeAction("pending")).toBe("run")
    expect(migrationResumeAction(null)).toBe("run")
    expect(migrationResumeAction("running")).toBe("ambiguous")
    expect(migrationResumeAction("failed")).toBe("stop")
    expect(migrationResumeAction("succeeded")).toBe("publish")
  })
})
