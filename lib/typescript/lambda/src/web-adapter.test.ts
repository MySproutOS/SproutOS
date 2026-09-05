import { beforeEach, describe, expect, it } from "vitest"

import {
  handlerForPreset,
  isRuntimeCompatible,
  isSupportedRuntime,
  RUNTIME_CATALOGUE,
  runtimeForPreset,
  webAdapterForRelease,
} from "./runtimes"
import {
  DEFAULT_WEB_ADAPTER_LAYER_VERSION,
  LAMBDA_ARCHITECTURE,
  startupScript,
  WEB_ADAPTER_HANDLER,
  webAdapterEnv,
  webAdapterLayerArn,
} from "./web-adapter"

describe("webAdapterLayerArn", () => {
  beforeEach(() => {
    delete process.env.LAMBDA_WEB_ADAPTER_LAYER_ARN
    delete process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION
  })

  it("falls back to the pinned version when nothing is configured", () => {
    // The control-plane deploy does not run `tofu apply`, so a variable added to user-data reaches
    // instances only on the next infrastructure change. A publish path that depends on one is a
    // publish path that refuses every web deployment until somebody notices.
    expect(webAdapterLayerArn("us-east-1")).toBe(
      `arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`,
    )
  })

  it("composes AWS's public layer ARN from the version and the region", () => {
    process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION = "29"
    expect(webAdapterLayerArn("us-east-1")).toBe(
      "arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:29",
    )
    expect(webAdapterLayerArn("eu-west-1")).toBe(
      "arn:aws:lambda:eu-west-1:753240598075:layer:LambdaAdapterLayerArm64:29",
    )
  })

  it("prefers an explicit ARN over the version", () => {
    process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION = "29"
    process.env.LAMBDA_WEB_ADAPTER_LAYER_ARN = "arn:aws:lambda:us-east-1:111:layer:Mine:3"
    expect(webAdapterLayerArn("us-east-1")).toBe("arn:aws:lambda:us-east-1:111:layer:Mine:3")
  })

  it("treats an empty override as unset rather than as a request for an empty layer", () => {
    // An unset Terraform variable arrives as `VAR=` rather than as an absent name, so the empty
    // string is the shape this actually sees when nobody configured it.
    process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION = ""
    process.env.LAMBDA_WEB_ADAPTER_LAYER_ARN = ""
    expect(webAdapterLayerArn("us-east-1")).toBe(
      `arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`,
    )
  })
})

describe("LAMBDA_ARCHITECTURE", () => {
  it("matches the adapter layer that is attached", () => {
    // The two are one decision. A layer for the other architecture is `cannot execute binary file`
    // at init, reported as the customer's function crashing — which is how the log extension spent
    // its entire existence.
    const arn = webAdapterLayerArn("us-east-1")
    expect(arn).toContain(LAMBDA_ARCHITECTURE === "arm64" ? "Arm64" : "X86")
  })
})

describe("webAdapterEnv", () => {
  it("sets the wrapper, and one port both ends agree on", () => {
    const env = webAdapterEnv()
    // Without the wrapper the layer is attached and inert: the function still looks for a handler
    // export and still fails, while its configuration looks correct.
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBe("/opt/bootstrap")
    // The adapter reads one of these and the framework reads the other. They must be equal, and
    // asserting the pair rather than the literal is what catches a change to only one.
    expect(env.AWS_LWA_PORT).toBe(env.PORT)
    expect(env.AWS_LWA_ERROR_STATUS_CODES).toBe("500-599")
  })

  it("lets a provided runtime start its own bootstrap while retaining the adapter ports", () => {
    const env = webAdapterEnv("provided.al2023")
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined()
    expect(env.AWS_LWA_PORT).toBe(env.PORT)
    expect(env.PORT).toBe("8080")
  })
})

describe("runtimeForPreset", () => {
  it("adapts the presets that produce a server, and only those", () => {
    expect(runtimeForPreset("next").webAdapter).toBe(true)
    expect(runtimeForPreset("hono").webAdapter).toBe(true)
    expect(runtimeForPreset("web")).toEqual({
      runtime: "provided.al2023",
      handler: "bootstrap",
      webAdapter: true,
    })
    expect(runtimeForPreset("function").webAdapter).toBe(false)
    // A static build has no server to adapt.
    expect(runtimeForPreset("static").webAdapter).toBe(false)
    // An unknown preset ships from the action's own repository. It must not silently become an
    // adapted build, because a handler-shaped archive with the wrapper set fails every invocation.
    expect(runtimeForPreset("something-new").webAdapter).toBe(false)
  })

  it("keeps the adapter when an explicit handler equals the preset convention", () => {
    expect(webAdapterForRelease("web", undefined)).toBe(true)
    expect(webAdapterForRelease("web", "bootstrap")).toBe(true)
    expect(webAdapterForRelease("next", "run.sh")).toBe(true)
    expect(webAdapterForRelease("web", "index.handler")).toBe(false)
  })

  it("gives an adapted preset the startup script as its handler", () => {
    // These two travel together: the adapter's contract is that the handler names a script in the
    // archive, and the action writes exactly this name. A preset claiming `index.handler` while
    // being adapted is the bug this whole module exists to fix.
    expect(runtimeForPreset("next").handler).toBe(WEB_ADAPTER_HANDLER)
    expect(runtimeForPreset("hono").handler).toBe(WEB_ADAPTER_HANDLER)
  })

  it("derives the hidden web handler from the selected runtime", () => {
    expect(handlerForPreset("web", "nodejs24.x")).toBe("run.sh")
    expect(handlerForPreset("web", "provided.al2023")).toBe("bootstrap")
  })
})

describe("runtime catalogue", () => {
  it("offers every supported ZIP runtime and excludes previews and container-only runtimes", () => {
    expect(RUNTIME_CATALOGUE).toHaveLength(21)
    expect(isSupportedRuntime("nodejs24.x")).toBe(true)
    expect(isSupportedRuntime("python3.14")).toBe(true)
    expect(isSupportedRuntime("java25")).toBe(true)
    expect(isSupportedRuntime("dotnet10")).toBe(true)
    expect(isSupportedRuntime("ruby4.0")).toBe(true)
    expect(isSupportedRuntime("nodejs26.x")).toBe(false)
    expect(isSupportedRuntime("python3.15")).toBe(false)
    expect(isSupportedRuntime("dotnet9")).toBe(false)
  })

  it("applies preset compatibility and excludes deprecated Node 20", () => {
    expect(isRuntimeCompatible("next", "nodejs24.x")).toBe(true)
    expect(isRuntimeCompatible("next", "python3.14")).toBe(false)
    expect(isRuntimeCompatible("function", "python3.14")).toBe(true)
    expect(isSupportedRuntime("nodejs20.x", new Date("2026-09-30T23:59:59Z"))).toBe(false)
  })
})

describe("startupScript", () => {
  it("execs the command", () => {
    // `exec` rather than a plain call: without it a shell sits between Lambda and the server, and
    // the server never sees a shutdown signal.
    expect(startupScript("node server.js")).toContain("exec node server.js")
  })
})
