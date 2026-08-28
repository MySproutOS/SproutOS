import { describe, expect, it } from "vitest"
import { primaryProjectSelectModel } from "./primary-project-select"

describe("PrimaryProjectSelect", () => {
  it("provides the child's name for a persisted selected id", () => {
    const childId = "01a03b96-a3d3-71f5-9f1d-af7569938433"

    const model = primaryProjectSelectModel(
      "group-id",
      [
        {
          id: childId,
          name: "Reddit Clone Web",
          isGroup: false,
          parentProjectId: "group-id",
        },
      ],
      childId,
    )

    expect(model.items.find((item) => item.value === model.value)?.label).toBe("Reddit Clone Web")
  })
})
