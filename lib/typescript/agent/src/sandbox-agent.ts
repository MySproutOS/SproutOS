import type { SandboxDriver } from "@lib/sandbox"

import type { Harness } from "./harness"
import type { AgentEvent } from "./runner"
import { codexConfig, sandboxAgentEnv } from "./sandbox-env"
import type { MintedProxyToken } from "./proxy-token"

/**
 * Running the coding agent **inside the sandbox**.
 *
 * ## Why this exists rather than the in-process runner
 *
 * `runner.ts` runs the agent in the API process, and `tools.ts` therefore refuses `Bash` — not
 * because command execution is unsafe in principle, it is the point of the product, but because the
 * subprocess shares a uid with the control plane and `cat /proc/1/environ` is the whole exploit. The
 * consequence is an agent that can read and edit files and cannot run a single command: no install,
 * no tests, no dev server. Which is also why the preview has never shown anything — nothing was
 * ever listening.
 *
 * Moving the agent into the sandbox removes the objection instead of working around it. There, a
 * shell is just a shell. The thing that makes it safe to hand a model a machine is that the machine
 * holds nothing worth stealing: the credential in it is a proxy token, minted for one session,
 * expiring in minutes, useless anywhere but our own listener.
 *
 * ## What is deliberately not written to disk
 *
 * The proxy token is passed per invocation through `env`, never into a file in the workspace. A
 * file would survive the turn, be readable by anything the agent later runs, and — since the
 * workspace is a git checkout — is one careless `git add -A` from being committed to the customer's
 * own repository.
 */

/** Where the checkout lives inside the sandbox. Matches the driver's own default. */
export const WORKSPACE = "/workspace"

/** Long enough for `npm install` on a cold sandbox, short enough that a hang is not forever. */
const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000

export type SandboxRepository = {
  /** `owner/name`, for the clone URL and for the commit trailer. */
  fullName: string
  branch: string
  /**
   * A GitHub App installation token.
   *
   * Short-lived by construction — an hour — which is why it is used for the clone and then removed
   * from the remote rather than left in `.git/config`, where it would outlive its usefulness and be
   * readable by everything the agent runs afterwards.
   */
  token: string
}

export type BootstrapInput = {
  driver: SandboxDriver
  externalId: string
  repository: SandboxRepository
  /** The SproutOS skill, already rendered. */
  skill: string
  harness: Harness
  proxyBaseUrl: string
  model: string | null
  /** Development database for this sandbox, when one has been branched for it. */
  databaseUrl?: string | null
  /** Who the commits belong to. */
  author: { name: string; email: string }
}

export type BootstrapResult = {
  cloned: boolean
  /** What failed, if anything. A partial bootstrap is reported rather than thrown. */
  problems: string[]
}

/**
 * Put a working checkout, an identity, and the platform's instructions into the sandbox.
 *
 * Reports problems rather than throwing on the first one. A sandbox with a checkout and no dev
 * database is still useful; refusing the whole bootstrap because a Neon branch failed would take
 * away the part that works. What must not happen is silence — every skipped step is named.
 */
export async function bootstrapSandbox(input: BootstrapInput): Promise<BootstrapResult> {
  const { driver, externalId } = input
  const problems: string[] = []

  const run = async (argv: string[], what: string): Promise<boolean> => {
    try {
      const result = await driver.exec(externalId, argv, BOOTSTRAP_TIMEOUT_MS)
      if (result.exitCode !== 0) {
        // The command's own stderr, trimmed. A generic "bootstrap failed" would make the customer
        // guess which of six steps it was.
        problems.push(`${what}: ${result.stderr.trim().slice(0, 400) || `exit ${result.exitCode}`}`)
        return false
      }
      return true
    } catch (cause) {
      problems.push(`${what}: ${String(cause)}`)
      return false
    }
  }

  /*
    The token goes in the clone URL and comes straight back out.

    `git clone https://x-access-token:<token>@github.com/...` is how an installation token is used,
    and it lands in `.git/config` as the remote's URL — where it is readable by everything the agent
    runs for the rest of the session, and by anyone who later reads the workspace. Rewriting the
    remote immediately afterwards is what stops that; the push path supplies a fresh token.
  */
  const cloneUrl = `https://x-access-token:${input.repository.token}@github.com/${input.repository.fullName}.git`
  const cloned = await run(
    ["git", "clone", "--depth", "50", "--branch", input.repository.branch, cloneUrl, WORKSPACE],
    "cloning the repository",
  )

  if (cloned) {
    await run(
      [
        "git",
        "-C",
        WORKSPACE,
        "remote",
        "set-url",
        "origin",
        `https://github.com/${input.repository.fullName}.git`,
      ],
      "removing the clone credential",
    )
    await run(
      ["git", "-C", WORKSPACE, "config", "user.name", input.author.name],
      "setting the commit author",
    )
    await run(
      ["git", "-C", WORKSPACE, "config", "user.email", input.author.email],
      "setting the commit email",
    )
  }

  /*
    The skill, in both places, because the two harnesses look in different ones.

    Claude Code reads `.claude/skills`; Codex reads `AGENTS.md` and knows nothing about skills. A
    skill written only for one is a skill that silently does not exist for half the customers —
    and the requirement was that it be *referenced a lot*, which starts with being found at all.
  */
  await write(
    driver,
    externalId,
    `${WORKSPACE}/.claude/skills/sproutos/SKILL.md`,
    input.skill,
    problems,
  )
  await write(driver, externalId, `${WORKSPACE}/AGENTS.md`, agentsPointer(input.skill), problems)

  /*
    Kept out of the customer's commits.

    These are ours, written into their checkout. `.git/info/exclude` rather than `.gitignore`
    because the latter is a tracked file and editing it would itself be a change the customer did
    not make.
  */
  await write(
    driver,
    externalId,
    `${WORKSPACE}/.git/info/exclude`,
    ["/.claude/skills/sproutos/", "/.codex/", ""].join("\n"),
    problems,
  )

  if (input.harness === "codex") {
    await write(
      driver,
      externalId,
      `${WORKSPACE}/.codex/config.toml`,
      codexConfig({ model: input.model ?? "gpt-5.6-terra", proxyBaseUrl: input.proxyBaseUrl }),
      problems,
    )
  }

  return { cloned, problems }
}

async function write(
  driver: SandboxDriver,
  externalId: string,
  path: string,
  content: string,
  problems: string[],
): Promise<void> {
  try {
    await driver.writeFile(externalId, path, content)
  } catch (cause) {
    problems.push(`writing ${path}: ${String(cause)}`)
  }
}

/**
 * `AGENTS.md`, which both harnesses read and which points at the skill.
 *
 * The skill's own body is inlined rather than referenced by path. "Reference it a lot" cannot be
 * satisfied by a link the model may or may not follow — a file it is given at the start of every
 * session is the only version of "a lot" that does not depend on the model choosing to look.
 */
function agentsPointer(skill: string): string {
  return `# Working on this repository in SproutOS

This checkout is inside a SproutOS sandbox. The platform's own conventions are below, and they
override habits from other projects — particularly around deployment, which SproutOS performs and
your build scripts must not.

${skill}
`
}

export type TurnInput = {
  driver: SandboxDriver
  externalId: string
  harness: Harness
  prompt: string
  proxyBaseUrl: string
  refreshUrl: string
  token: MintedProxyToken
  model: string | null
  timeoutMs: number
  onEvent: (event: AgentEvent) => void
}

/**
 * Run one turn in the sandbox and stream what it does.
 *
 * The CLI is asked for newline-delimited JSON, which is the same event vocabulary the SDK yields —
 * so the chat surface consumes an identical stream whether the turn ran here or in the API process.
 * Two transports, one contract; the alternative is two chat clients.
 */
export async function runSandboxTurn(input: TurnInput): Promise<{ exitCode: number }> {
  const env = sandboxAgentEnv({
    harness: input.harness,
    model: input.model,
    proxyBaseUrl: input.proxyBaseUrl,
    refreshUrl: input.refreshUrl,
    token: input.token,
  })

  /*
    `env K=V ... cmd` rather than a file.

    The proxy token would otherwise have to be written into the workspace, where it outlives the
    turn, is readable by anything the agent runs, and — the workspace being a git checkout — is one
    `git add -A` from the customer's own repository.
  */
  const argv = ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)]
  argv.push(...harnessArgv(input.harness, input.prompt))

  let buffer = ""
  const result = await input.driver.execStream(
    input.externalId,
    argv,
    input.timeoutMs,
    (chunk) => {
      /*
        Buffered to line boundaries.

        A chunk can end mid-line — mid-*number*, even — and `JSON.parse` on a fragment throws. Code
        that parses per chunk works on every short reply and loses events under a real turn, which
        is the worst distribution of failures for a transcript somebody is watching.
      */
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== "") emit(line, input.onEvent)
        newline = buffer.indexOf("\n")
      }
    },
    (chunk) => {
      // The CLI's own diagnostics. Surfaced rather than swallowed: "nothing happened" is the least
      // debuggable outcome, and a missing binary reports itself here and nowhere else.
      const text = chunk.trim()
      if (text !== "") input.onEvent({ type: "error", message: text.slice(0, 500) })
    },
  )

  if (buffer.trim() !== "") emit(buffer.trim(), input.onEvent)
  return { exitCode: result.exitCode }
}

function harnessArgv(harness: Harness, prompt: string): string[] {
  switch (harness) {
    case "claude-code":
      // `--verbose` is required alongside `stream-json` for the CLI to emit tool events rather than
      // only the final message — without it the transcript is a single block of text at the end.
      return ["claude", "--print", "--output-format", "stream-json", "--verbose", prompt]
    case "codex":
      return ["codex", "exec", "--json", "--cd", WORKSPACE, prompt]
  }
}

/**
 * One line of the harness's output, as an event the chat already understands.
 *
 * Unrecognised shapes are dropped rather than forwarded. The vocabulary here is the same deliberate
 * narrowing `runner.ts` documents: a transcript that carried every message type either harness ever
 * emits would put hook lifecycle and worker notices into `agent_event`, which holds customer source
 * and has a retention promise attached.
 */
function emit(line: string, onEvent: (event: AgentEvent) => void): void {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }

  const type = parsed.type

  if (type === "system" && parsed.subtype === "init") {
    const id = parsed.session_id
    if (typeof id === "string") onEvent({ type: "session", sdkSessionId: id })
    return
  }

  if (type === "assistant" || type === "item.completed") {
    for (const event of textAndTools(parsed)) onEvent(event)
    return
  }

  if (type === "result" || type === "turn.completed") {
    onEvent({
      type: "done",
      subtype: typeof parsed.subtype === "string" ? parsed.subtype : "success",
      isError: parsed.is_error === true,
      numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : 1,
      durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
    })
  }
}

/** Text blocks and tool calls out of a harness message, in either spelling. */
function textAndTools(parsed: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = []
  const message = (parsed.message ?? parsed.item) as Record<string, unknown> | undefined
  const content = message?.content

  if (typeof content === "string") {
    if (content !== "") events.push({ type: "text", text: content })
    return events
  }
  if (!Array.isArray(content)) return events

  for (const block of content) {
    const item = block as Record<string, unknown>
    if (item.type === "text" && typeof item.text === "string" && item.text !== "") {
      events.push({ type: "text", text: item.text })
    }
    if (item.type === "tool_use" && typeof item.name === "string") {
      events.push({ type: "tool_use", name: item.name, input: item.input })
    }
  }
  return events
}
