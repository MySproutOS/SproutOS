import { describe, expect, it } from "vitest"

import type { AgentEvent } from "./runner"
import { bootstrapSandbox, commitSandboxWork, runSandboxTurn } from "./sandbox-agent"
import { SANDBOX_NETWORK_LAUNCHER } from "./sandbox-network"

const WORKSPACE = "/home/daytona/workspace"

function fakeDriver(
  options: {
    stdout?: string[]
    execExit?: number
    /** Canned stdout, keyed by a substring of the command. */
    results?: Record<string, string>
    /** Commands that should come back non-zero, keyed the same way, with their stderr. */
    failures?: Record<string, string>
    /** Files already present in the cloned repository. */
    files?: Record<string, string>
  } = {},
) {
  const commands: string[][] = []
  const secretEnvironments: Record<string, string>[] = []
  const clones: Array<{ url: string; password: string }> = []
  const files: Record<string, string> = { ...options.files }
  const driver = {
    workspaceDir: WORKSPACE,
    cloneRepository: (_id: string, input: { url: string; password: string }) => {
      clones.push({ url: input.url, password: input.password })
      if (options.execExit) return Promise.reject(new Error("clone failed"))
      return Promise.resolve()
    },
    exec: (_id: string, argv: string[]) => {
      commands.push(argv)
      const line = argv.join(" ")
      for (const [needle, stderr] of Object.entries(options.failures ?? {})) {
        if (line.includes(needle)) return Promise.resolve({ stdout: "", stderr, exitCode: 1 })
      }
      for (const [needle, stdout] of Object.entries(options.results ?? {})) {
        if (line.includes(needle)) return Promise.resolve({ stdout, stderr: "", exitCode: 0 })
      }
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
    execStreamWithSecrets: (
      _id: string,
      argv: string[],
      env: Record<string, string>,
      _timeout: number,
      onStdout: (chunk: string) => void,
    ) => {
      commands.push(argv)
      secretEnvironments.push(env)
      for (const chunk of options.stdout ?? []) onStdout(chunk)
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })
    },
    writeFile: (_id: string, path: string, content: string) => {
      files[path] = content
      return Promise.resolve()
    },
    readFile: (_id: string, path: string) =>
      Promise.resolve(files[path] ?? "# SproutOS platform instructions\nVerify your work.\n"),
  } as never
  return { clones, commands, driver, files, secretEnvironments }
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

  it("keeps the clone credential out of sandbox commands and the remote", async () => {
    const { clones, commands, driver } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })

    expect(clones).toEqual([
      { url: "https://github.com/acme/app.git", password: "ghs_installation" },
    ])
    expect(commands.flat().join(" ")).not.toContain("ghs_installation")

    /*
      The provider receives the credential as an API field, while the sandbox and its Git remote
      only ever see the credential-free URL. The push path supplies a fresh token separately.
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

  it("puts the skill where both harnesses look without writing into the repository", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })

    expect(files[`${WORKSPACE}/.git/sproutos/codex/AGENTS.md`]).toContain(
      "Deployment is performed by the platform",
    )
    expect(files[`${WORKSPACE}/${SANDBOX_NETWORK_LAUNCHER}`]).toContain("CONNECT ")
    expect(files[`${WORKSPACE}/AGENTS.md`]).toBeUndefined()
    expect(files[`${WORKSPACE}/.claude/skills/sproutos/SKILL.md`]).toBeUndefined()
  })

  it("installs inherited-model Codex roles outside the customer's worktree", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({
      ...base,
      driver,
      externalId: "sb",
      harness: "codex",
      model: "gpt-5.6-terra",
    })

    const small = files[`${WORKSPACE}/.git/sproutos/codex/agents/small.toml`] ?? ""
    const large = files[`${WORKSPACE}/.git/sproutos/codex/agents/large.toml`] ?? ""
    expect(small).toContain('name = "small"')
    expect(small).toContain('model_reasoning_effort = "low"')
    expect(large).toContain('name = "large"')
    expect(large).toContain('model_reasoning_effort = "high"')
    // The parent selection is Terra for platform credit and the customer's selection for BYO.
    expect(`${small}\n${large}`).not.toMatch(/^model\s*=/m)
    expect(files[`${WORKSPACE}/.codex/agents/small.toml`]).toBeUndefined()
  })

  it("leaves a BYO Codex model's reasoning effort inherited", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({
      ...base,
      driver,
      externalId: "sb",
      harness: "codex",
      model: "openrouter/customer-model",
    })

    const roles = `${files[`${WORKSPACE}/.git/sproutos/codex/agents/small.toml`]}\n${
      files[`${WORKSPACE}/.git/sproutos/codex/agents/large.toml`]
    }`
    expect(roles).not.toMatch(/^model\s*=/m)
    expect(roles).not.toContain("model_reasoning_effort")
  })

  it("preserves the repository's own AGENTS.md", async () => {
    const repositoryInstructions = "# Customer instructions\nDo not replace me.\n"
    const { driver, files } = fakeDriver({
      files: { [`${WORKSPACE}/AGENTS.md`]: repositoryInstructions },
    })

    await bootstrapSandbox({ ...base, driver, externalId: "sb" })

    expect(files[`${WORKSPACE}/AGENTS.md`]).toBe(repositoryInstructions)
    expect(files[`${WORKSPACE}/.git/sproutos/codex/AGENTS.md`]).toContain("SproutOS")
  })

  it("writes no ignore rule because platform state is outside the worktree", async () => {
    const { driver, files } = fakeDriver()
    await bootstrapSandbox({ ...base, driver, externalId: "sb" })
    expect(files[`${WORKSPACE}/.git/info/exclude`]).toBeUndefined()
  })

  it("writes no Codex config at all, for either harness", async () => {
    /*
      It used to write one, and Codex overwrote the file with its own trust entry on the first turn
      — taking the provider with it, so the next turn went to `wss://api.openai.com` with no key.
      The settings are passed per invocation now; see `codexOverrides`.
    */
    for (const harness of ["claude-code", "codex"] as const) {
      const { driver, files } = fakeDriver()
      await bootstrapSandbox({ ...base, driver, externalId: "sb", harness })
      expect(files[`${WORKSPACE}/.codex/config.toml`]).toBeUndefined()
    }
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

  it("keeps both proxy tokens out of the command and workspace", async () => {
    const { commands, driver, files, secretEnvironments } = fakeDriver()
    await runSandboxTurn({ ...base, driver, onEvent: () => {} })

    const argv = commands[0]?.join(" ") ?? ""
    expect(argv).not.toContain("spa_access")
    expect(argv).not.toContain("spr_refresh")
    expect(argv).not.toContain("ANTHROPIC_API_KEY")
    expect(argv).not.toMatch(/sk-[A-Za-z0-9]/)

    // The values exist only in the driver's explicitly sensitive channel, where Daytona delivers
    // them over non-echoing stdin. No platform write during a turn can leave them in the checkout.
    expect(secretEnvironments).toHaveLength(1)
    expect(JSON.stringify(secretEnvironments[0])).toContain("spa_access")
    expect(JSON.stringify(secretEnvironments[0])).toContain("spr_refresh")
    expect(JSON.stringify(secretEnvironments[0])).toContain("https://llm.sproutos.me")
    expect(JSON.stringify(files)).not.toContain("spa_access")
    expect(JSON.stringify(files)).not.toContain("spr_refresh")
  })

  it("gives Claude Code the platform skill explicitly", async () => {
    const platformInstructions = "# Platform-owned\nNever deploy by hand.\n"
    const { commands, driver } = fakeDriver({
      files: { [`${WORKSPACE}/.git/sproutos/codex/AGENTS.md`]: platformInstructions },
    })
    await runSandboxTurn({ ...base, driver, onEvent: () => {} })

    expect(commands[0]).toContain("--append-system-prompt-file")
    expect(commands[0]).toContain(`${WORKSPACE}/.git/sproutos/codex/AGENTS.md`)
    const childPrompt = commands[0]?.indexOf("--append-subagent-system-prompt") ?? -1
    expect(childPrompt).toBeGreaterThan(-1)
    expect(commands[0]?.[childPrompt + 1]).toBe(platformInstructions)
  })

  it("caps Claude children and provides small and large inherited-model roles", async () => {
    const { commands, driver, secretEnvironments } = fakeDriver()
    await runSandboxTurn({ ...base, driver, model: "gpt-5.6-terra", onEvent: () => {} })

    expect(secretEnvironments[0]).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2",
    })
    const agentsAt = commands[0]?.indexOf("--agents") ?? -1
    const agents = JSON.parse(commands[0]?.[agentsAt + 1] ?? "{}") as Record<
      string,
      Record<string, unknown>
    >
    expect(agents.small).toMatchObject({ effort: "low", maxTurns: 8, model: "inherit" })
    expect(agents.large).toMatchObject({ effort: "high", maxTurns: 24, model: "inherit" })
    expect(JSON.stringify(agents)).not.toContain("gpt-5.6-terra")
  })

  it("does not force platform effort settings onto a BYO model", async () => {
    const { commands, driver } = fakeDriver()
    await runSandboxTurn({ ...base, driver, model: "claude-opus-byo", onEvent: () => {} })

    const agentsAt = commands[0]?.indexOf("--agents") ?? -1
    const agents = JSON.parse(commands[0]?.[agentsAt + 1] ?? "{}") as Record<
      string,
      Record<string, unknown>
    >
    expect(agents.small).toMatchObject({ maxTurns: 8, model: "inherit" })
    expect(agents.large).toMatchObject({ maxTurns: 24, model: "inherit" })
    expect(agents.small).not.toHaveProperty("effort")
    expect(agents.large).not.toHaveProperty("effort")
  })

  it("enables Codex delegation with the same two-child cap", async () => {
    const { commands, driver, files } = fakeDriver()
    await runSandboxTurn({ ...base, harness: "codex", driver, onEvent: () => {} })

    const argv = commands[0]?.join(" ") ?? ""
    expect(argv).toContain("agents.enabled=true")
    expect(argv).toContain("agents.max_concurrent_threads_per_session=2")
    expect(files[`${WORKSPACE}/.git/sproutos/codex/agents/small.toml`]).toContain(
      'model_reasoning_effort = "low"',
    )
  })

  it("refreshes Codex roles without a Terra-only effort when a sandbox changes to BYO", async () => {
    const { driver, files } = fakeDriver({
      files: {
        [`${WORKSPACE}/.git/sproutos/codex/agents/small.toml`]: 'model_reasoning_effort = "low"\n',
      },
    })
    await runSandboxTurn({
      ...base,
      harness: "codex",
      model: "openrouter/customer-model",
      driver,
      onEvent: () => {},
    })

    expect(files[`${WORKSPACE}/.git/sproutos/codex/agents/small.toml`]).not.toContain(
      "model_reasoning_effort",
    )
  })

  it("runs every harness through the platform network launcher", async () => {
    const { commands, driver } = fakeDriver()
    await runSandboxTurn({ ...base, driver, onEvent: () => {} })

    expect(commands[0]).toContain("node")
    expect(commands[0]).toContain(`${WORKSPACE}/${SANDBOX_NETWORK_LAUNCHER}`)
    expect(commands[0]).toContain("--")
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

describe("commitSandboxWork", () => {
  const base = {
    author: { email: "dev@example.com", name: "Dev" },
    baseBranch: "main",
    branch: "sproutos/agent-abc",
    externalId: "sb",
    message: "Add a thing",
    repository: "octocat/Hello-World",
    token: "ghs_installation",
  }

  it("says nothing changed rather than making an empty commit", async () => {
    // The common case: a turn that answered a question without touching a file. A caller that had
    // to catch an exception to find that out would eventually catch a real failure with it.
    const { commands, driver } = fakeDriver()
    const result = await commitSandboxWork({ ...base, driver })

    expect(result).toEqual({ committed: false, reason: "no_changes" })
    // Nothing was staged, committed or pushed on the way to that answer.
    expect(commands.map((argv) => argv.join(" ")).join("\n")).not.toContain("commit")
  })

  it("keeps the credential out of the URL, and pushes to an explicit ref", async () => {
    const { commands, driver } = fakeDriver({
      results: {
        "status --porcelain": " M src/app.ts\n?? README.md\n",
        "ls-remote --refs":
          "0123456789abcdef0123456789abcdef01234567\trefs/heads/sproutos/agent-abc\n",
        "rev-parse HEAD": "abc123\n",
      },
    })

    const result = await commitSandboxWork({ ...base, driver })
    expect(result).toEqual({
      committed: true,
      sha: "abc123",
      branch: "sproutos/agent-abc",
      files: ["src/app.ts", "README.md"],
    })

    const push = commands.find((argv) => argv.includes("push"))!
    /*
      The URL carries no credential. `git push <url>` with one in it leaves it in the reflog, and a
      remote set from it leaves it in `.git/config` — both outlive the push by an hour of validity.
    */
    expect(push).toContain("https://github.com/octocat/Hello-World.git")
    expect(push.join(" ")).not.toContain("x-access-token")
    expect(push.join(" ")).not.toContain("ghs_installation@")
    // The clone is off the production branch, so the local branch is called that. An explicit ref
    // is what lets the agent's work land somewhere else without a checkout dance.
    expect(push).toContain("HEAD:refs/heads/sproutos/agent-abc")
    expect(push).toContain(
      "--force-with-lease=refs/heads/sproutos/agent-abc:0123456789abcdef0123456789abcdef01234567",
    )

    const observed = commands.find((argv) => argv.includes("ls-remote"))!
    expect(observed).toContain("refs/heads/sproutos/agent-abc")
    expect(observed.join(" ")).not.toContain("ghs_installation@")

    // An identity on the command itself: `git commit` refuses without one, and the bootstrap's
    // `git config` is a step that is allowed to have failed.
    const commit = commands.find((argv) => argv.includes("commit"))!
    expect(commit.join(" ")).toContain("user.email=dev@example.com")
  })

  it("pushes work the agent already committed even when the worktree is clean", async () => {
    const { commands, driver } = fakeDriver({
      results: {
        "diff --name-only refs/remotes/origin/main..HEAD": "docs/launch-smoke.md\n",
        "rev-parse HEAD": "c12eea3\n",
      },
    })

    const result = await commitSandboxWork({ ...base, driver })
    expect(result).toEqual({
      committed: true,
      sha: "c12eea3",
      branch: "sproutos/agent-abc",
      files: ["docs/launch-smoke.md"],
    })
    expect(commands.some((argv) => argv.includes("commit"))).toBe(false)
    expect(commands.find((argv) => argv.includes("push"))).toContain(
      "HEAD:refs/heads/sproutos/agent-abc",
    )
  })

  it("creates a branch only when the authenticated remote read says it is absent", async () => {
    const { commands, driver } = fakeDriver({
      results: {
        "status --porcelain": " M src/app.ts\n",
        "rev-parse HEAD": "abc123\n",
      },
    })

    await commitSandboxWork({ ...base, driver })

    const push = commands.find((argv) => argv.includes("push"))!
    expect(push).toContain("--force-with-lease=refs/heads/sproutos/agent-abc:")
  })

  it("reports which step failed, not just that something did", async () => {
    // "the push failed" and "the commit failed" send a person to different places. A single generic
    // error sends them to neither.
    const { driver } = fakeDriver({
      results: { "status --porcelain": " M a.ts\n" },
      failures: { push: "remote: Permission to octocat/Hello-World.git denied" },
    })

    await expect(commitSandboxWork({ ...base, driver })).rejects.toThrow(/the push failed/)
  })
})
