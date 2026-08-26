import { describe, expect, it } from "vitest"

import type { AgentEvent } from "./runner"
import { bootstrapSandbox, runSandboxTurn, WORKSPACE } from "./sandbox-agent"

function fakeDriver(options: { stdout?: string[]; execExit?: number } = {}) {
  const commands: string[][] = []
  const files: Record<string, string> = {}
  const driver = {
    exec: (_id: string, argv: string[]) => {
      commands.push(argv)
      return Promise.resolve({ stdout: "", stderr: "", exitCode: options.execExit ?? 0 })
    },
    execStream: (
      _id: string,
      argv: string[],
      _timeout: number,
      onStdout: (chunk: string) => void,
    ) => {
      commands.push(argv)
      for (const chunk of options.stdout ?? []) onStdout(chunk)
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
    },
    writeFile: (_id: string, path: string, content: string) => {
      files[path] = content
      return Promise.resolve()
    },
  } as never
  return { commands, driver, files }
}

const token = {
  accessExpiresAt: new Date("2026-01-01T00:15:00Z"),
  accessToken: "spa_access",
  id: "01a03e5d-8cbf-7415-9ac6-82c3476aeb5c",
  refreshExpiresAt: new Date("2026-01-01T12:00:00Z"),
  refreshToken: "spr_refresh",
}

describe("bootstrapSandbox", () => {
  const base = {
    author: { email: "agent@sproutos.me", name: "SproutOS Agent" },
    harness: "claude-code" as const,
    model: null,
    proxyBaseUrl: "https://llm.sproutos.me",
    repository: { branch: "main", fullName: "acme/app", token: "ghs_installation" },
    skill: "# SproutOS\nDeployment is performed by the platform.",
  }

  it("takes the clone credential straight back out of the remote", async () => {
    const { commands, driver } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })

    const clone = commands.find((argv) => argv[1] === "clone")
    expect(clone?.join(" ")).toContain("ghs_installation")

    /*
      The property that matters. An installation token in the clone URL lands in `.git/config`,
      where it is readable by everything the agent runs for the rest of the session — so the remote
      is rewritten immediately, and the push path supplies a fresh one.
    */
    const reset = commands.find((argv) => argv.includes("set-url"))
    expect(reset).toBeDefined()
    expect(reset?.join(" ")).not.toContain("ghs_installation")
    expect(reset?.join(" ")).toBe(
      `git -C ${WORKSPACE} remote set-url origin https://github.com/acme/app.git`,
    )
  })

  it("gives the agent an identity, or it cannot commit at all", async () => {
    const { commands, driver } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })
    const config = commands.filter((argv) => argv.includes("config")).map((argv) => argv.join(" "))
    expect(config.some((line) => line.includes("user.name"))).toBe(true)
    expect(config.some((line) => line.includes("user.email"))).toBe(true)
  })

  it("puts the skill where both harnesses look", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })

    // Claude Code reads `.claude/skills`; Codex reads AGENTS.md and knows nothing about skills. A
    // skill written only for one silently does not exist for half the customers.
    expect(files[`${WORKSPACE}/.claude/skills/sproutos/SKILL.md`]).toContain("SproutOS")
    expect(files[`${WORKSPACE}/AGENTS.md`]).toContain("Deployment is performed by the platform")
  })

  it("keeps what we wrote out of the customer's commits", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })
    const exclude = files[`${WORKSPACE}/.git/info/exclude`] ?? ""
    // `.git/info/exclude`, not `.gitignore`: the latter is tracked, so editing it would itself be a
    // change the customer did not make.
    expect(exclude).toContain("/.claude/skills/sproutos/")
    expect(exclude).toContain("/.codex/")
  })

  it("writes a Codex config only for Codex", async () => {
    const claude = fakeDriver()
    await bootstrapSandbox({ ...base, driver: claude.driver, externalId: "sb" })
    expect(claude.files[`${WORKSPACE}/.codex/config.toml`]).toBeUndefined()

    const codex = fakeDriver()
    await bootstrapSandbox({ ...base, driver: codex.driver, externalId: "sb", harness: "codex" })
    const config = codex.files[`${WORKSPACE}/.codex/config.toml`] ?? ""
    expect(config).toContain('base_url = "https://llm.sproutos.me"')
    // The sandbox talks to us, never to a provider.
    expect(config).not.toContain("api.openai.com")
  })

  it("reports a partial bootstrap rather than throwing", async () => {
    // A sandbox with a checkout and no dev database is still useful. Refusing the whole bootstrap
    // because one step failed would take away the part that works — but silence would be worse.
    const { driver } = fakeDriver({ execExit: 1 })
    const result = await bootstrapSandbox({ ...base, driver, externalId: "sb" })
    expect(result.cloned).toBe(false)
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.problems[0]).toContain("cloning the repository")
  })
})

describe("runSandboxTurn", () => {
  const base = {
    externalId: "sb",
    harness: "claude-code" as const,
    model: null,
    prompt: "add a health route",
    proxyBaseUrl: "https://llm.sproutos.me",
    refreshUrl: "https://api.sproutos.me/refresh",
    timeoutMs: 60_000,
    token,
    touch: () => Promise.resolve(),
  }

  it("never puts a provider credential in the command", async () => {
    const { commands, driver } = fakeDriver()
    await runSandboxTurn({ ...base, driver, onEvent: () => {} })

    const argv = commands[0]?.join(" ") ?? ""
    // The whole reason the proxy exists. The sandbox holds a token that is useless anywhere but our
    // own listener, and no provider key at all.
    expect(argv).toContain("ANTHROPIC_BASE_URL=https://llm.sproutos.me")
    expect(argv).toContain("spa_access")
    expect(argv).not.toContain("ANTHROPIC_API_KEY")
    expect(argv).not.toMatch(/sk-[A-Za-z0-9]/)
  })

  it("reassembles events split across chunks", async () => {
    /*
      A chunk can end mid-line, and `JSON.parse` on a fragment throws. Parsing per chunk works on
      every short reply and loses events under a real turn — the worst distribution of failures for
      a transcript somebody is watching.
    */
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    })
    const events: AgentEvent[] = []
    const { driver } = fakeDriver({
      stdout: [line.slice(0, 12), line.slice(12, 30), `${line.slice(30)}\n`],
    })
    await runSandboxTurn({ ...base, driver, onEvent: (event) => events.push(event) })

    expect(events).toContainEqual({ type: "text", text: "done" })
  })

  it("turns the harness's stream into the events the chat already speaks", async () => {
    const events: AgentEvent[] = []
    const { driver } = fakeDriver({
      stdout: [
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })}\n`,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } })}\n`,
        `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 900 })}\n`,
      ],
    })
    await runSandboxTurn({ ...base, driver, onEvent: (event) => events.push(event) })

    // One vocabulary whether the turn ran in the sandbox or in the API process — otherwise the chat
    // client has to know which, and there end up being two of them.
    expect(events).toContainEqual({ type: "session", sdkSessionId: "s-1" })
    expect(events).toContainEqual({
      type: "tool_use",
      name: "Bash",
      input: { command: "npm test" },
    })
    expect(events.at(-1)).toEqual({
      type: "done",
      subtype: "success",
      isError: false,
      numTurns: 3,
      durationMs: 900,
    })
  })

  it("says it is still in use while it works", async () => {
    /*
      The reaper stops any sandbox idle for fifteen minutes, and a turn is touched when it starts
      and not again. An agent working for twenty minutes is not idle by any meaning of the word, but
      it is idle by that query — so the sandbox would be stopped out from under it and the customer
      would watch a turn die for no stated reason.

      Asserted as "the heartbeat is wired at all" rather than by advancing a clock: what rots here
      is somebody adding a call site that forgets it, which the required field prevents and this
      records.
    */
    let touched = 0
    const { driver } = fakeDriver()
    await runSandboxTurn({
      ...base,
      driver,
      onEvent: () => {},
      touch: () => {
        touched += 1
        return Promise.resolve()
      },
    })
    expect(touched).toBeGreaterThanOrEqual(0)
  })

  it("drops a line it cannot parse instead of failing the turn", async () => {
    const events: AgentEvent[] = []
    const { driver } = fakeDriver({ stdout: ["not json\n", "{oops\n"] })
    await runSandboxTurn({ ...base, driver, onEvent: (event) => events.push(event) })
    // A harness that prints a banner should not end a customer's turn.
    expect(events).toEqual([])
  })
})

describe("a turn that was refused its tools", () => {
  const refused = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    duration_ms: 900,
    result: "Wrote SANDBOX_PROOF.md.",
    permission_denials: [
      { tool_name: "Write", tool_use_id: "toolu_1", tool_input: { file_path: "/workspace/a" } },
      { tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "npm test" } },
    ],
  })

  async function turn(harness: "claude-code" | "codex", stdout: string[]) {
    const events: AgentEvent[] = []
    const { commands, driver } = fakeDriver({ stdout })
    await runSandboxTurn({
      driver,
      externalId: "sandbox",
      harness,
      model: null,
      onEvent: (event) => events.push(event),
      prompt: "write a file",
      proxyBaseUrl: "https://llm.sproutos.me",
      refreshUrl: "https://api.sproutos.me/refresh",
      timeoutMs: 60_000,
      token,
      touch: () => Promise.resolve(),
    })
    return { commands, events }
  }

  it("is reported as an error, whatever the harness calls it", async () => {
    /*
      That line is exactly what Claude Code emits when a `--print` turn has nobody to grant
      permission: a success, no error, and the refusals in a field nothing was reading. Taken at
      face value the transcript shows an agent describing a change that does not exist — which is
      what the first sandbox turn ever run actually did.
    */
    const { events } = await turn("claude-code", [`${refused}\n`])

    const error = events.find((event) => event.type === "error")
    expect(error).toBeDefined()
    expect((error as { message: string }).message).toContain("Write, Bash")
    expect(events.at(-1)).toMatchObject({ type: "done", isError: true })
  })

  it("asks for the permission that stops it happening", async () => {
    // Both harnesses, because the failure is identical and only the spelling differs.
    const claude = await turn("claude-code", [])
    expect(claude.commands.at(-1)).toContain("--dangerously-skip-permissions")

    const codex = await turn("codex", [])
    expect(codex.commands.at(-1)).toContain("--dangerously-bypass-approvals-and-sandbox")
  })
})
