import { beforeEach, describe, expect, it } from "vitest"

import { runtimeForPreset } from "./runtimes"
import {
  DEFAULT_WEB_ADAPTER_LAYER_VERSION,
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
      `arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerX86:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`,
    )
  })

  it("composes AWS's public layer ARN from the version and the region", () => {
    process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION = "29"
    expect(webAdapterLayerArn("us-east-1")).toBe(
      "arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerX86:29",
    )
    expect(webAdapterLayerArn("eu-west-1")).toBe(
      "arn:aws:lambda:eu-west-1:753240598075:layer:LambdaAdapterLayerX86:29",
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
      `arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerX86:${DEFAULT_WEB_ADAPTER_LAYER_VERSION}`,
    )
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
  })
})

describe("runtimeForPreset", () => {
  it("adapts the presets that produce a server, and only those", () => {
    expect(runtimeForPreset("next").webAdapter).toBe(true)
    expect(runtimeForPreset("hono").webAdapter).toBe(true)
    // A static build has no server to adapt.
    expect(runtimeForPreset("static").webAdapter).toBe(false)
    // An unknown preset ships from the action's own repository. It must not silently become an
    // adapted build, because a handler-shaped archive with the wrapper set fails every invocation.
    expect(runtimeForPreset("something-new").webAdapter).toBe(false)
  })

  it("gives an adapted preset the startup script as its handler", () => {
    // These two travel together: the adapter's contract is that the handler names a script in the
    // archive, and the action writes exactly this name. A preset claiming `index.handler` while
    // being adapted is the bug this whole module exists to fix.
    expect(runtimeForPreset("next").handler).toBe(WEB_ADAPTER_HANDLER)
    expect(runtimeForPreset("hono").handler).toBe(WEB_ADAPTER_HANDLER)
  })
})

describe("startupScript", () => {
  it("execs the command", () => {
    // `exec` rather than a plain call: without it a shell sits between Lambda and the server, and
    // the server never sees a shutdown signal.
    expect(startupScript("node server.js")).toContain("exec node server.js")
  })
})
