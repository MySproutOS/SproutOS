import { describe, expect, it } from "vitest"
import {
  AUTO_ARCHIVE_AFTER_STOP_MINUTES,
  buildCreateParams,
  daytonaConfigFromEnv,
  type DaytonaConfig,
} from "./daytona"
import type { CreateSandboxInput } from "./types"

const config: DaytonaConfig = {
  apiKey: "k",
  organizationId: "org",
  snapshot: "sproutos/agent:1",
}

const input: CreateSandboxInput = {
  sandboxId: "01930000-0000-7000-8000-000000000001",
  organizationId: "01930000-0000-7000-8000-0000000000aa",
  projectId: "01930000-0000-7000-8000-0000000000bb",
  userId: "01930000-0000-7000-8000-0000000000cc",
  sandboxClass: "container",
  alwaysOn: false,
  resources: { cpu: 2, memoryGib: 4, diskGib: 10 },
  idleTimeoutS: 900,
}

describe("buildCreateParams", () => {
  it("uses the snapshot's fixed resources instead of sending an invalid override", () => {
    const params = buildCreateParams(config, input)
    expect(params.snapshot).toBe("sproutos/agent:1")
    expect(params.name).toBe(`sproutos-${input.sandboxId}`)
    expect(params).not.toHaveProperty("resources")
  })

  it("refuses to bill a size different from the snapshot's actual size", () => {
    expect(() =>
      buildCreateParams(config, { ...input, resources: { ...input.resources, cpu: 4 } }),
    ).toThrow(/fixed at 2 CPU/)
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

  it("does not restrict outbound domains", () => {
    const params = buildCreateParams(config, input)
    expect(params.domainAllowList).toBeUndefined()
    expect(params.networkAllowList).toBeUndefined()
  })

  describe("autostop backstop", () => {
    it("is disabled only for an explicitly always-on sandbox", () => {
      expect(buildCreateParams(config, { ...input, alwaysOn: true }).autoStopInterval).toBe(0)
    })

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

  it("archives stopped containers before reserved disk can bill indefinitely", () => {
    expect(buildCreateParams(config, input).autoArchiveInterval).toBe(
      AUTO_ARCHIVE_AFTER_STOP_MINUTES,
    )
  })

  it("omits envVars when there are none rather than sending an empty object", () => {
    expect(buildCreateParams(config, input).envVars).toBeUndefined()
    expect(buildCreateParams(config, { ...input, env: { A: "1" } }).envVars).toEqual({ A: "1" })
  })
})

describe("daytonaConfigFromEnv", () => {
  it("refuses a missing api key", () => {
    expect(() =>
      daytonaConfigFromEnv({
        DAYTONA_ORGANIZATION_ID: "org",
        SANDBOX_DAYTONA_SNAPSHOT: "s",
      }),
    ).toThrow(/DAYTONA_API_KEY/)
  })

  it("refuses a missing organization", () => {
    expect(() =>
      daytonaConfigFromEnv({ DAYTONA_API_KEY: "k", SANDBOX_DAYTONA_SNAPSHOT: "s" }),
    ).toThrow(/DAYTONA_ORGANIZATION_ID/)
  })

  /*
    The snapshot has no default on purpose: a provider default image starts cleanly, contains no
    agent, and reports no error. The failure would present as the chat doing nothing.
  */
  it("refuses a missing snapshot", () => {
    expect(() =>
      daytonaConfigFromEnv({ DAYTONA_API_KEY: "k", DAYTONA_ORGANIZATION_ID: "org" }),
    ).toThrow(/SANDBOX_DAYTONA_SNAPSHOT/)
  })

  it("treats an empty string as unset", () => {
    expect(() =>
      daytonaConfigFromEnv({
        DAYTONA_API_KEY: "",
        DAYTONA_ORGANIZATION_ID: "org",
        SANDBOX_DAYTONA_SNAPSHOT: "s",
      }),
    ).toThrow(/DAYTONA_API_KEY/)
  })

  it("omits optional fields rather than passing empty ones through", () => {
    const c = daytonaConfigFromEnv({
      DAYTONA_API_KEY: "k",
      DAYTONA_ORGANIZATION_ID: "org",
      SANDBOX_DAYTONA_SNAPSHOT: "s",
    })
    expect(c).toEqual({ apiKey: "k", organizationId: "org", snapshot: "s" })
  })
})
