import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"

import { dockerConfigFromEnv, dockerDriver } from "@lib/sandbox"

import { bootstrapSandbox, runSandboxTurn, WORKSPACE } from "./sandbox-agent"

const run = promisify(execFile)

/**
 * Bootstrap and a turn, in a container that actually exists.
 *
 * `sandbox-agent.test.ts` proves the logic against a fake driver. This proves the operations it is
 * built out of survive contact with a real one: a real clone over the network, markdown full of
 * quotes written to a real filesystem, a real `git config`, and a real process streaming
 * newline-delimited JSON back.
 *
 * The clone is of a public repository over HTTPS with no token — the token path is identical and
 * cannot be exercised without a customer's installation.
 */
const available = await (async () => {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

const driver = dockerDriver({ ...dockerConfigFromEnv(), image: "node:24-slim" })
const created: string[] = []

afterAll(async () => {
  for (const id of created) await driver.destroy(id).catch(() => {})
})

async function sandbox(name: string): Promise<string> {
  const made = await driver.create({
    sandboxId: `${name}-${Date.now()}`,
    organizationId: "org",
    projectId: "project",
    userId: "user",
    sandboxClass: "container",
    resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
    idleTimeoutS: 900,
  })
  created.push(made.externalId)
  // git is not in `node:24-slim`, and the Daytona snapshot is expected to carry it. Installed here
  // rather than assumed, because a bootstrap that fails on a missing binary is exactly the failure
  // this test exists to catch — see the day `git` was missing from the control-plane instances.
  await driver.exec(
    made.externalId,
    ["sh", "-c", "apt-get update -qq && apt-get install -y -qq git"],
    300_000,
  )
  return made.externalId
}

describe.skipIf(!available)("bootstrapping a real sandbox", () => {
  it("clones, sets an identity, and installs the skill where both harnesses look", async () => {
    const externalId = await sandbox("bootstrap")

    const skill = '# SproutOS\n\nIt\'s "deployment" — `$(not a command)` and a `backtick`.\n'
    const result = await bootstrapSandbox({
      author: { email: "agent@sproutos.me", name: "SproutOS Agent" },
      driver,
      externalId,
      harness: "codex",
      model: "gpt-5.6-terra",
      proxyBaseUrl: "https://llm.sproutos.me",
      repository: {
        // Small, public, and stable. The token path is byte-identical.
        branch: "master",
        fullName: "octocat/Hello-World",
        token: "",
      },
      skill,
    })

    expect(result.problems).toEqual([])
    expect(result.cloned).toBe(true)

    // A real checkout, not an empty directory.
    const readme = await driver.readFile(externalId, `${WORKSPACE}/README`)
    expect(readme.length).toBeGreaterThan(0)

    // The skill survived a filesystem round trip with its quotes and backticks intact — the thing a
    // shell-interpolated write would have destroyed.
    expect(await driver.readFile(externalId, `${WORKSPACE}/.claude/skills/sproutos/SKILL.md`)).toBe(
      skill,
    )
    expect(await driver.readFile(externalId, `${WORKSPACE}/AGENTS.md`)).toContain("deployment")

    // An identity, or the agent cannot commit at all.
    const identity = await driver.exec(
      externalId,
      ["git", "-C", WORKSPACE, "config", "user.email"],
      30_000,
    )
    expect(identity.stdout.trim()).toBe("agent@sproutos.me")

    // And the credential is gone from the remote.
    const remote = await driver.exec(
      externalId,
      ["git", "-C", WORKSPACE, "remote", "get-url", "origin"],
      30_000,
    )
    expect(remote.stdout).not.toContain("x-access-token")

    // What we wrote is invisible to git, so the agent's first commit does not carry our scaffolding
    // into the customer's repository.
    const status = await driver.exec(
      externalId,
      ["git", "-C", WORKSPACE, "status", "--porcelain"],
      30_000,
    )
    expect(status.stdout).not.toContain(".claude/skills")
    expect(status.stdout).not.toContain(".codex")
  }, 600_000)

  it("streams a turn's events out of the container", async () => {
    const externalId = await sandbox("turn")

    /*
      A stand-in harness that emits the same newline-delimited JSON the real ones do, written into
      the container and run as the agent would be. What is under test is the transport and the
      parsing — that events survive being produced by a separate process, in a container, arriving
      in arbitrary chunks — not the model.
    */
    await driver.writeFile(
      externalId,
      "/usr/local/bin/claude",
      [
        "#!/bin/sh",
        `echo '{"type":"system","subtype":"init","session_id":"live-1"}'`,
        `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}'`,
        `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"the base url is '"$ANTHROPIC_BASE_URL"'"}]}}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":1200}'`,
        "",
      ].join("\n"),
    )
    await driver.exec(externalId, ["chmod", "+x", "/usr/local/bin/claude"], 30_000)

    const events: unknown[] = []
    const { exitCode } = await runSandboxTurn({
      driver,
      externalId,
      harness: "claude-code",
      model: null,
      onEvent: (event) => events.push(event),
      prompt: "say hello",
      proxyBaseUrl: "https://llm.sproutos.me",
      refreshUrl: "https://api.sproutos.me/refresh",
      timeoutMs: 120_000,
      token: {
        accessExpiresAt: new Date(Date.now() + 600_000),
        accessToken: "spa_live",
        id: "01a03e5d-8cbf-7415-9ac6-82c3476aeb5c",
        refreshExpiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: "spr_live",
      },
      touch: () => Promise.resolve(),
    })

    expect(exitCode).toBe(0)
    expect(events).toContainEqual({ type: "session", sdkSessionId: "live-1" })
    expect(events).toContainEqual({
      type: "tool_use",
      name: "Bash",
      input: { command: "npm test" },
    })
    // The harness saw the proxy, which is the whole reason the sandbox holds no provider key.
    expect(JSON.stringify(events)).toContain("the base url is https://llm.sproutos.me")
    expect(events.at(-1)).toEqual({
      type: "done",
      subtype: "success",
      isError: false,
      numTurns: 2,
      durationMs: 1200,
    })
  }, 600_000)
})
