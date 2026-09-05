import { describe, expect, it } from "vitest"
import {
  handlerForPreset,
  isRuntimeCompatible,
  isSupportedRuntime,
  runtimeForPreset,
} from "./runtimes"

describe("runtime catalogue", () => {
  it("recommends Node.js 24 and keeps preview and container-only runtimes out", () => {
    expect(runtimeForPreset("next")).toMatchObject({ runtime: "nodejs24.x", handler: "run.sh" })
    expect(isSupportedRuntime("nodejs26.x")).toBe(false)
    expect(isSupportedRuntime("python3.15")).toBe(false)
    expect(isSupportedRuntime("dotnet9")).toBe(false)
  })

  it("rejects deprecated runtimes while historical deployment rows can retain their identifier", () => {
    expect(isSupportedRuntime("nodejs20.x", new Date("2026-09-30T23:59:59Z"))).toBe(false)
    expect(isSupportedRuntime("nodejs20.x")).toBe(false)
  })

  it("keeps web-framework presets on Node and function packages language-neutral", () => {
    expect(isRuntimeCompatible("next", "python3.14")).toBe(false)
    expect(isRuntimeCompatible("function", "python3.14")).toBe(true)
    expect(isRuntimeCompatible("web", "python3.14")).toBe(false)
    expect(runtimeForPreset("web")).toMatchObject({
      runtime: "provided.al2023",
      handler: "bootstrap",
    })
    expect(handlerForPreset("web", "provided.al2023")).toBe("bootstrap")
  })
})
