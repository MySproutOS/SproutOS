import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  AUTO_ARCHIVE_AFTER_STOP_MINUTES,
  DAYTONA_DELETE_TIMEOUT_SECONDS,
  DAYTONA_READ_MAX_ATTEMPTS,
  buildCreateParams,
  daytonaConfigFromEnv,
  deleteDaytonaSandboxAndWait,
  executeDaytonaSensitiveStream,
  retryIdempotentDaytonaRead,
  sandboxForwardProxyPassword,
  startDaytonaSandbox,
  type DaytonaConfig,
} from "./daytona"
import { SandboxUnavailableError, type CreateSandboxInput } from "./types"

const config: DaytonaConfig = {
  apiKey: "k",
  organizationId: "org",
  snapshot: "sproutos/agent:1",
  forwardProxyUrl: "http://egress.sproutos.me:3128",
  forwardProxyRootKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
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

async function runRecordedCommand(
  command: string,
  stdin: string,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (exitCode) => {
      resolve({ stdout, stderr, exitCode })
    })
    child.stdin.end(stdin)
  })
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

  it("rejects the unsupported android class instead of silently creating a container", () => {
    expect(() => buildCreateParams(config, { ...input, sandboxClass: "android" })).toThrow(
      /android is unsupported; only container sandboxes/,
    )
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

  it("routes all HTTP traffic through the authenticated platform proxy", () => {
    const proxy = new URL(buildCreateParams(config, input).outboundProxyUrl!)
    expect(`${proxy.protocol}//${proxy.host}`).toBe("http://egress.sproutos.me:3128")
    expect(proxy.username).toBe(input.sandboxId)
    expect(proxy.password).toBe("_OA0k2a79uUCiL9bKly4ERxxh9fl1NChPL2VwVzvDbU")
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

describe("Daytona provider failures", () => {
  it("preserves the provider status, headers and Retry-After", () => {
    const cause = {
      statusCode: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "12",
      },
    }
    const error = new SandboxUnavailableError("daytona", cause)

    expect(error.statusCode).toBe(429)
    expect(error.headers).toEqual(cause.headers)
    expect(error.retryAfter).toBe("12")
  })

  it("also preserves Axios-shaped response metadata", () => {
    const error = new SandboxUnavailableError("daytona", {
      response: { status: 503, headers: { "retry-after-sandbox-create": "4" } },
    })

    expect(error.statusCode).toBe(503)
    expect(error.headers).toEqual({ "retry-after-sandbox-create": "4" })
    expect(error.retryAfter).toBe("4")
  })

  it("retries a rate-limited idempotent read using Retry-After", async () => {
    let attempts = 0
    const delays: number[] = []
    const rateLimit = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      headers: { "retry-after": "0.01" },
    })
    const result = await retryIdempotentDaytonaRead(
      () => {
        attempts += 1
        if (attempts < 3) return Promise.reject(rateLimit)
        return Promise.resolve("ok")
      },
      (delayMs) => {
        delays.push(delayMs)
        return Promise.resolve()
      },
    )

    expect(result).toBe("ok")
    expect(attempts).toBe(3)
    expect(delays).toEqual([10, 10])
  })

  it("bounds rate-limit attempts and never retries other provider failures", async () => {
    let rateLimitAttempts = 0
    const rateLimitError = Object.assign(new Error("rate limited"), { statusCode: 429 })
    await expect(
      retryIdempotentDaytonaRead(
        () => {
          rateLimitAttempts += 1
          return Promise.reject(rateLimitError)
        },
        () => Promise.resolve(),
      ),
    ).rejects.toBe(rateLimitError)
    expect(rateLimitAttempts).toBe(DAYTONA_READ_MAX_ATTEMPTS)

    let unavailableAttempts = 0
    const unavailable = Object.assign(new Error("unavailable"), { statusCode: 503 })
    await expect(
      retryIdempotentDaytonaRead(() => {
        unavailableAttempts += 1
        return Promise.reject(unavailable)
      }),
    ).rejects.toBe(unavailable)
    expect(unavailableAttempts).toBe(1)
  })
})

describe("Daytona deletion", () => {
  it("waits for Daytona to confirm the sandbox is destroyed", async () => {
    const calls: unknown[][] = []
    const sandbox = {
      delete: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve()
      },
    }

    await deleteDaytonaSandboxAndWait(sandbox)

    expect(calls).toEqual([[DAYTONA_DELETE_TIMEOUT_SECONDS, true]])
  })
})

describe("Daytona start reconciliation", () => {
  it("accepts a start that completes after the SDK response times out", async () => {
    const states = ["starting", "started"]
    let now = 0
    const sandbox = {
      state: "stopped",
      start: () => Promise.reject(new Error("request timed out")),
      refreshData() {
        this.state = states.shift() ?? "started"
        return Promise.resolve()
      },
    }

    await startDaytonaSandbox(sandbox, {
      now: () => now,
      sleep: (delayMs) => {
        now += delayMs
        return Promise.resolve()
      },
      timeoutMs: 10_000,
      intervalMs: 1_000,
    })

    expect(sandbox.state).toBe("started")
  })

  it("preserves the original start error when Daytona never reaches running", async () => {
    const startError = new Error("request timed out")
    let now = 0
    const sandbox = {
      state: "starting",
      start: () => Promise.reject(startError),
      refreshData: () => Promise.resolve(),
    }

    await expect(
      startDaytonaSandbox(sandbox, {
        now: () => now,
        sleep: (delayMs) => {
          now += delayMs
          return Promise.resolve()
        },
        timeoutMs: 2_000,
        intervalMs: 1_000,
      }),
    ).rejects.toBe(startError)
  })
})

describe("Daytona sensitive stream transport", () => {
  it("puts secrets only in suppressed session input, never retained metadata or logs", async () => {
    const accessToken = "spa_adversarial_access"
    const refreshToken = "spr_adversarial_refresh"
    const commandRequests: Array<{ command: string; suppressInputEcho?: boolean }> = []
    const sentInputs: string[] = []
    const deletedSessions: string[] = []
    const durableLogs = { stdout: [] as string[], stderr: [] as string[] }
    const persistedWorkspace: Record<string, string> = {}

    const process = {
      createSession: () => Promise.resolve(),
      deleteSession: (sessionId: string) => {
        deletedSessions.push(sessionId)
        return Promise.resolve()
      },
      executeSessionCommand: (
        _sessionId: string,
        request: { command: string; suppressInputEcho?: boolean },
      ) => {
        commandRequests.push(request)
        return Promise.resolve({ cmdId: "command-1" })
      },
      sendSessionCommandInput: (_sessionId: string, _commandId: string, data: string) => {
        sentInputs.push(data)
        return Promise.resolve()
      },
      getSessionCommandLogs: (
        _sessionId: string,
        _commandId: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void,
      ) => {
        onStdout("agent output\n")
        onStderr("agent diagnostic\n")
        return Promise.resolve()
      },
      getSessionCommand: () =>
        Promise.resolve({
          id: "command-1",
          command: commandRequests[0]?.command ?? "",
          exitCode: 0,
        }),
    }

    const streamed = await executeDaytonaSensitiveStream({
      process: process as never,
      sessionId: "session-1",
      argv: ["node", "/workspace/agent.js", "--prompt", "make it work"],
      env: { SPROUT_PROXY_ACCESS_TOKEN: accessToken, SPROUT_PROXY_REFRESH_TOKEN: refreshToken },
      timeoutMs: 1_000,
      onStdout: (chunk) => durableLogs.stdout.push(chunk),
      onStderr: (chunk) => durableLogs.stderr.push(chunk),
    })

    expect(commandRequests).toHaveLength(1)
    expect(commandRequests[0]?.suppressInputEcho).toBe(true)
    expect(sentInputs).toHaveLength(1)
    expect(sentInputs[0]).toContain(accessToken)
    expect(sentInputs[0]).toContain(refreshToken)

    /*
      These are the durable surfaces exposed by Daytona and by our sandbox filesystem contract.
      The input endpoint is deliberately excluded: it is the one ephemeral carrier, and echo is
      suppressed on the command before the first byte is sent.
    */
    const durableSurfaces = JSON.stringify({
      commandRequests,
      sessionMetadata: {
        commands: [{ command: commandRequests[0]?.command, exitCode: 0 }],
      },
      durableLogs,
      persistedWorkspace,
    })
    expect(durableSurfaces).not.toContain(accessToken)
    expect(durableSurfaces).not.toContain(refreshToken)
    expect(streamed).toEqual({
      result: {
        stdout: "agent output\n",
        stderr: "agent diagnostic\n",
        exitCode: 0,
      },
      keepSession: true,
    })
    // Keeping the session is what lets an agent-started dev server survive into the preview.
    expect(deletedSessions).toEqual([])

    // Execute the exact fixed command we recorded, not a second test-only launcher. This proves
    // that the stdin payload becomes child argv/environment without being interpolated into it.
    const probeInput = JSON.stringify({
      argv: [
        globalThis.process.execPath,
        "-e",
        "console.log(JSON.stringify({argument:process.argv[1],hasAccess:Boolean(process.env.SPROUT_PROXY_ACCESS_TOKEN),hasRefresh:Boolean(process.env.SPROUT_PROXY_REFRESH_TOKEN)}))",
        "argument with spaces",
      ],
      env: { SPROUT_PROXY_ACCESS_TOKEN: accessToken, SPROUT_PROXY_REFRESH_TOKEN: refreshToken },
    })
    const probe = await runRecordedCommand(commandRequests[0]?.command ?? "", `${probeInput}\n`)
    expect(probe).toEqual({
      stdout: `${JSON.stringify({
        argument: "argument with spaces",
        hasAccess: true,
        hasRefresh: true,
      })}\n`,
      stderr: "",
      exitCode: 0,
    })
  })

  it("deletes a failed sensitive session instead of retaining credentials in process state", async () => {
    const deletedSessions: string[] = []
    const process = {
      createSession: () => Promise.resolve(),
      deleteSession: (sessionId: string) => {
        deletedSessions.push(sessionId)
        return Promise.resolve()
      },
      executeSessionCommand: () => Promise.resolve({ cmdId: "command-2" }),
      sendSessionCommandInput: () => Promise.resolve(),
      getSessionCommandLogs: () => Promise.resolve(),
      getSessionCommand: () =>
        Promise.resolve({ id: "command-2", command: "node -e fixed", exitCode: 1 }),
    }

    const streamed = await executeDaytonaSensitiveStream({
      process: process as never,
      sessionId: "session-failed",
      argv: ["false"],
      env: { TOKEN: "secret" },
      timeoutMs: 1_000,
      onStdout: () => {},
      onStderr: () => {},
    })

    expect(streamed.keepSession).toBe(false)
    expect(deletedSessions).toEqual(["session-failed"])
  })
})

describe("daytonaConfigFromEnv", () => {
  const proxyEnv = {
    SANDBOX_FORWARD_PROXY_URL: "http://egress.sproutos.me:3128",
    SANDBOX_FORWARD_PROXY_ROOT_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  }
  it("refuses a missing api key", () => {
    expect(() =>
      daytonaConfigFromEnv({
        DAYTONA_ORGANIZATION_ID: "org",
        SANDBOX_DAYTONA_SNAPSHOT: "s",
        ...proxyEnv,
      }),
    ).toThrow(/DAYTONA_API_KEY/)
  })

  it("refuses a missing organization", () => {
    expect(() =>
      daytonaConfigFromEnv({ DAYTONA_API_KEY: "k", SANDBOX_DAYTONA_SNAPSHOT: "s", ...proxyEnv }),
    ).toThrow(/DAYTONA_ORGANIZATION_ID/)
  })

  /*
    The snapshot has no default on purpose: a provider default image starts cleanly, contains no
    agent, and reports no error. The failure would present as the chat doing nothing.
  */
  it("refuses a missing snapshot", () => {
    expect(() =>
      daytonaConfigFromEnv({
        DAYTONA_API_KEY: "k",
        DAYTONA_ORGANIZATION_ID: "org",
        ...proxyEnv,
      }),
    ).toThrow(/SANDBOX_DAYTONA_SNAPSHOT/)
  })

  it("treats an empty string as unset", () => {
    expect(() =>
      daytonaConfigFromEnv({
        DAYTONA_API_KEY: "",
        DAYTONA_ORGANIZATION_ID: "org",
        SANDBOX_DAYTONA_SNAPSHOT: "s",
        ...proxyEnv,
      }),
    ).toThrow(/DAYTONA_API_KEY/)
  })

  it("omits optional fields rather than passing empty ones through", () => {
    const c = daytonaConfigFromEnv({
      DAYTONA_API_KEY: "k",
      DAYTONA_ORGANIZATION_ID: "org",
      SANDBOX_DAYTONA_SNAPSHOT: "s",
      ...proxyEnv,
    })
    expect(c).toEqual({
      apiKey: "k",
      organizationId: "org",
      snapshot: "s",
      forwardProxyUrl: proxyEnv.SANDBOX_FORWARD_PROXY_URL,
      forwardProxyRootKey: proxyEnv.SANDBOX_FORWARD_PROXY_ROOT_KEY,
    })
  })

  it("requires and validates the forward proxy configuration", () => {
    const base = {
      DAYTONA_API_KEY: "k",
      DAYTONA_ORGANIZATION_ID: "org",
      SANDBOX_DAYTONA_SNAPSHOT: "s",
    }
    expect(() => daytonaConfigFromEnv(base)).toThrow(/SANDBOX_FORWARD_PROXY_URL/)
    expect(() =>
      daytonaConfigFromEnv({ ...base, ...proxyEnv, SANDBOX_FORWARD_PROXY_URL: "https://proxy" }),
    ).toThrow(/HTTP origin/)
    expect(() =>
      daytonaConfigFromEnv({ ...base, ...proxyEnv, SANDBOX_FORWARD_PROXY_ROOT_KEY: "bad" }),
    ).toThrow(/32 bytes/)
  })
})

describe("sandbox forward proxy credential contract", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../rust/sandbox-forward-proxy/fixtures/credentials.json", import.meta.url),
      "utf8",
    ),
  ) as {
    rootKeyBase64: string
    vectors: { sandboxId: string; password: string }[]
  }

  it.each(fixture.vectors)("matches the Rust vector for $sandboxId", ({ sandboxId, password }) => {
    expect(sandboxForwardProxyPassword(fixture.rootKeyBase64, sandboxId)).toBe(password)
  })
})
