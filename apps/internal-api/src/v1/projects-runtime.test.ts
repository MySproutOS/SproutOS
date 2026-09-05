import { describe, expect, it } from "vitest"
import { projectRuntimeConfiguration } from "./projects"

describe("project runtime configuration", () => {
  it("defaults Lambda-backed projects and gives presets ownership of framework handlers", () => {
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "next",
        isGroup: false,
        kind: "site",
      }),
    ).toEqual({ deploymentPreset: "next", runtime: "nodejs24.x", handler: "run.sh" })
  })

  it("requires an explicit handler for a generic function package", () => {
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "function",
        runtime: "python3.14",
        isGroup: false,
        kind: "site",
      }),
    ).toMatchObject({ target: "handler" })
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "function",
        runtime: "python3.14",
        handler: "app.handler",
        isGroup: false,
        kind: "site",
      }),
    ).toEqual({
      deploymentPreset: "function",
      runtime: "python3.14",
      handler: "app.handler",
    })
  })

  it("rejects incompatible and deprecated runtimes", () => {
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "next",
        runtime: "python3.14",
        isGroup: false,
        kind: "site",
      }),
    ).toMatchObject({ target: "runtime" })
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "next",
        runtime: "nodejs20.x",
        isGroup: false,
        kind: "site",
      }),
    ).toMatchObject({ target: "runtime" })
  })

  it("keeps groups and non-Lambda targets runtime-free", () => {
    expect(
      projectRuntimeConfiguration({ deploymentPreset: null, isGroup: true, kind: "site" }),
    ).toEqual({ deploymentPreset: null, runtime: null, handler: null })
    expect(
      projectRuntimeConfiguration({
        deploymentPreset: "static",
        isGroup: false,
        kind: "site",
      }),
    ).toEqual({ deploymentPreset: "static", runtime: null, handler: null })
  })
})
