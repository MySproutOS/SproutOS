import { describe, expect, it } from "vitest"
import { logExtensionLayerForProject } from "./log-extension"

const ARN = "arn:aws:lambda:us-east-1:123456789012:layer:sproutos-log-extension:7"

describe("logExtensionLayerForProject", () => {
  it("attaches nothing by default, even when an old layer ARN remains configured", () => {
    expect(
      logExtensionLayerForProject("project-a", { LOG_EXTENSION_LAYER_ARN: ARN }),
    ).toBeUndefined()
  })

  it("attaches only to an explicitly listed canary project", () => {
    const environment = {
      LOG_EXTENSION_LAYER_ARN: ARN,
      LOG_EXTENSION_CANARY_PROJECT_IDS: " project-a,project-b ",
    }
    expect(logExtensionLayerForProject("project-a", environment)).toBe(ARN)
    expect(logExtensionLayerForProject("project-c", environment)).toBeUndefined()
  })

  it("attaches globally only for the exact true switch and a non-empty ARN", () => {
    expect(
      logExtensionLayerForProject("project-a", {
        LOG_EXTENSION_LAYER_ARN: ARN,
        LOG_EXTENSION_ENABLED: "TRUE",
      }),
    ).toBe(ARN)
    expect(
      logExtensionLayerForProject("project-a", { LOG_EXTENSION_ENABLED: "true" }),
    ).toBeUndefined()
    expect(
      logExtensionLayerForProject("project-a", {
        LOG_EXTENSION_LAYER_ARN: ARN,
        LOG_EXTENSION_ENABLED: "yes",
      }),
    ).toBeUndefined()
  })
})
