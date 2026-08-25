import { describe, expect, it } from "vitest"
import { buildCreateParams, daytonaConfigFromEnv, type DaytonaConfig } from "./daytona"
import type { CreateSandboxInput } from "./types"

const config: DaytonaConfig = { apiKey: "k", snapshot: "sproutos/agent:1" }

const input: CreateSandboxInput = {
  sandboxId: "01930000-0000-7000-8000-000000000001",
  organizationId: "01930000-0000-7000-8000-0000000000aa",
  projectId: "01930000-0000-7000-8000-0000000000bb",
  userId: "01930000-0000-7000-8000-0000000000cc",
  sandboxClass: "container",
  resources: { cpu: 2, memoryGib: 4, diskGib: 10 },
  idleTimeoutS: 900,
}

describe("buildCreateParams", () => {
  /*
    The resources workaround. `CreateSandboxFromSnapshotParams` does not declare `resources`, but
    `Daytona.create` reads them at runtime and the REST call takes them flat. If that ever stops
    being true, sandboxes come back at the provider's default size — which does not fail, it just
    bills a different number than `sandbox.meter` charges for. This is the assertion that notices.
  */
  it("sends resources alongside a snapshot", () => {
    const params = buildCreateParams(config, input)
    expect(params.snapshot).toBe("sproutos/agent:1")
    expect(params.resources).toEqual({ cpu: 2, memory: 4, disk: 10 })
  })

  it("carries attribution on the labels metering reads", () => {
    // finding 0011: the label the agent read was not the label the renderer wrote, and the whole
    // platform metered to nobody with every check passing.
    expect(buildCreateParams(config, input).labels).toEqual({
      "sproutos.dev/organization-id": input.organizationId,
      "sproutos.dev/project-id": input.projectId,
      "sproutos.dev/user-id": input.userId,
      "sproutos.dev/sandbox-id": input.sandboxId,
    })
  })

  it("is never public", () => {
    expect(buildCreateParams(config, input).public).toBe(false)
  })

  it("blocks link-local and private egress", () => {
    const list = buildCreateParams(config, input).networkAllowList ?? ""
    expect(list).not.toBe("")
    expect(list.split(",")).not.toContain("169.254.0.0/16")
    expect(list.split(",")).not.toContain("10.0.0.0/8")
    expect(list.split(",")).toContain("1.0.0.0/8")
  })

  describe("autostop backstop", () => {
    it("converts seconds to minutes", () => {
      expect(buildCreateParams(config, { ...input, idleTimeoutS: 900 }).autoStopInterval).toBe(15)
    })

    /*
      Zero means *disabled*, not immediate. A sandbox with a 30-second idle timeout that rounded to
      zero would have the provider's backstop silently turned off, and would then run until our own
      reaper noticed — or forever, if the reaper is the thing that broke.
    */
    it.each([1, 30, 59])("never disables itself for a %ss timeout", (idleTimeoutS) => {
      expect(buildCreateParams(config, { ...input, idleTimeoutS }).autoStopInterval).toBe(1)
    })

    it("rounds up rather than down", () => {
      expect(buildCreateParams(config, { ...input, idleTimeoutS: 61 }).autoStopInterval).toBe(2)
    })
  })

  it("omits envVars when there are none rather than sending an empty object", () => {
    expect(buildCreateParams(config, input).envVars).toBeUndefined()
    expect(buildCreateParams(config, { ...input, env: { A: "1" } }).envVars).toEqual({ A: "1" })
  })
})

describe("daytonaConfigFromEnv", () => {
  it("refuses a missing api key", () => {
    expect(() => daytonaConfigFromEnv({ SANDBOX_DAYTONA_SNAPSHOT: "s" })).toThrow(
      /SANDBOX_DAYTONA_API_KEY/,
    )
  })

  /*
    The snapshot has no default on purpose: a provider default image starts cleanly, contains no
    agent, and reports no error. The failure would present as the chat doing nothing.
  */
  it("refuses a missing snapshot", () => {
    expect(() => daytonaConfigFromEnv({ SANDBOX_DAYTONA_API_KEY: "k" })).toThrow(
      /SANDBOX_DAYTONA_SNAPSHOT/,
    )
  })

  it("treats an empty string as unset", () => {
    expect(() =>
      daytonaConfigFromEnv({ SANDBOX_DAYTONA_API_KEY: "", SANDBOX_DAYTONA_SNAPSHOT: "s" }),
    ).toThrow(/SANDBOX_DAYTONA_API_KEY/)
  })

  it("omits optional fields rather than passing empty ones through", () => {
    const c = daytonaConfigFromEnv({ SANDBOX_DAYTONA_API_KEY: "k", SANDBOX_DAYTONA_SNAPSHOT: "s" })
    expect(c).toEqual({ apiKey: "k", snapshot: "s" })
  })
})
