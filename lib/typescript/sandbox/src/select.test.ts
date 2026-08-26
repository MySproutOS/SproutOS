import { describe, expect, it } from "vitest"

import { sandboxDriverFromEnv, sandboxDriverName } from "./select"

describe("choosing a sandbox driver", () => {
  it("refuses to guess when nothing is configured", () => {
    // The point of the test: no key, no variable, and the answer is an error rather than a quiet
    // fallback onto the local container.
    expect(() => sandboxDriverName({})).toThrow(/SANDBOX_DRIVER is not set/)
    expect(() => sandboxDriverName({ SANDBOX_DAYTONA_API_KEY: "key" })).toThrow(
      /SANDBOX_DRIVER is not set/,
    )
  })

  it("names the options when the value is not one of them", () => {
    expect(() => sandboxDriverName({ SANDBOX_DRIVER: "firecracker" })).toThrow(/daytona, docker/)
  })

  it("builds the docker driver without any vendor configuration", () => {
    // Which is the whole point of it existing: a developer with no account can still run a sandbox.
    expect(sandboxDriverFromEnv({ SANDBOX_DRIVER: "docker" })).toBeDefined()
  })

  it("still requires Daytona's own configuration when Daytona is chosen", () => {
    // Choosing the driver does not excuse configuring it. A missing snapshot produces a sandbox
    // with no agent in it, so it fails here rather than at the first silent turn.
    expect(() => sandboxDriverFromEnv({ SANDBOX_DRIVER: "daytona" })).toThrow(
      /SANDBOX_DAYTONA_API_KEY/,
    )
    expect(() =>
      sandboxDriverFromEnv({ SANDBOX_DRIVER: "daytona", SANDBOX_DAYTONA_API_KEY: "key" }),
    ).toThrow(/SANDBOX_DAYTONA_SNAPSHOT/)
  })
})
