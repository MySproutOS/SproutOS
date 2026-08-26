import { afterAll, afterEach, describe, expect, it } from "vitest"

import {
  daytonaConfigFromEnv,
  sandboxDriverFromEnv,
  SNAPSHOT_RESOURCES,
  type SandboxDriver,
} from "@lib/sandbox"

import { bootstrapSandbox, commitSandboxWork, runSandboxTurn } from "./sandbox-agent"

/** This suite has no Docker substitute: every live assertion crosses Daytona's API. */
try {
  process.loadEnvFile()
} catch {
  // CI may supply variables directly, and a checkout may intentionally have no .env.
}

let driver: SandboxDriver | undefined
try {
  daytonaConfigFromEnv()
  driver = sandboxDriverFromEnv()
} catch {
  driver = undefined
}

const created: string[] = []
const workspace = driver?.workspaceDir ?? "/home/daytona/workspace"

afterAll(async () => {
  if (driver === undefined) return
  for (const id of created) await driver.destroy(id).catch(() => {})
})

afterEach(async () => {
  if (driver === undefined) return
  const ids = created.splice(0)
  for (const id of ids) await driver.destroy(id).catch(() => {})
})

async function sandbox(name: string): Promise<string> {
  if (driver === undefined) throw new Error("Daytona is unavailable")
  const made = await driver.create({
    sandboxId: `${name}-${Date.now()}`,
    organizationId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sandboxClass: "container",
    resources: SNAPSHOT_RESOURCES,
    idleTimeoutS: 900,
  })
  created.push(made.externalId)
  return made.externalId
}

describe.skipIf(driver === undefined)("bootstrapping a Daytona sandbox", () => {
  it("clones, sets an identity, and installs the skill where both harnesses look", async () => {
    const externalId = await sandbox("bootstrap")
    const activeDriver = driver!
    const skill = '# SproutOS\n\nIt\'s "deployment" — `$(not a command)` and a `backtick`.\n'
    const result = await bootstrapSandbox({
      author: { email: "agent@sproutos.me", name: "SproutOS Agent" },
      driver: activeDriver,
      externalId,
      harness: "codex",
      model: "gpt-5.6-terra",
      proxyBaseUrl: "https://llm.sproutos.me",
      repository: { branch: "master", fullName: "octocat/Hello-World", token: "" },
      skill,
    })

    expect(result.problems).toEqual([])
    expect(result.cloned).toBe(true)
    expect((await activeDriver.readFile(externalId, `${workspace}/README`)).length).toBeGreaterThan(
      0,
    )
    expect(
      await activeDriver.readFile(externalId, `${workspace}/.claude/skills/sproutos/SKILL.md`),
    ).toBe(skill)
    expect(await activeDriver.readFile(externalId, `${workspace}/AGENTS.md`)).toContain(
      "deployment",
    )

    const identity = await activeDriver.exec(
      externalId,
      ["git", "-C", workspace, "config", "user.email"],
      30_000,
    )
    expect(identity.stdout.trim()).toBe("agent@sproutos.me")
    const remote = await activeDriver.exec(
      externalId,
      ["git", "-C", workspace, "remote", "get-url", "origin"],
      30_000,
    )
    expect(remote.stdout).not.toContain("x-access-token")

    const curl = await activeDriver.exec(externalId, ["sh", "-c", "command -v curl"], 30_000)
    expect({ exitCode: curl.exitCode, stderr: curl.stderr }).toMatchObject({ exitCode: 0 })
    const arbitraryDomain = await activeDriver.exec(
      externalId,
      ["curl", "--fail", "--silent", "--show-error", "https://www.google.com/generate_204"],
      30_000,
    )
    expect({ exitCode: arbitraryDomain.exitCode, stderr: arbitraryDomain.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    })
    const metadata = await activeDriver.exec(
      externalId,
      [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "3",
        "http://169.254.169.254/latest/meta-data/",
      ],
      10_000,
    )
    expect(metadata.exitCode).not.toBe(0)
  }, 600_000)

  it("streams and parses a harness turn through Daytona", async () => {
    const externalId = await sandbox("turn")
    const activeDriver = driver!
    const stub = `${workspace}/../bin/claude`
    await activeDriver.writeFile(
      externalId,
      stub,
      [
        "#!/bin/sh",
        `echo '{"type":"system","subtype":"init","session_id":"live-1"}'`,
        `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}'`,
        `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"the base url is '"$ANTHROPIC_BASE_URL"'"}]}}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":1200}'`,
        "",
      ].join("\n"),
    )
    await activeDriver.exec(externalId, ["chmod", "+x", stub], 30_000)

    const events: unknown[] = []
    const { exitCode } = await runSandboxTurn({
      driver: activeDriver,
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
        id: crypto.randomUUID(),
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
    expect(JSON.stringify(events)).toContain("the base url is https://llm.sproutos.me")
    expect(events.at(-1)).toEqual({
      type: "done",
      subtype: "success",
      isError: false,
      numTurns: 2,
      durationMs: 1200,
    })
  }, 600_000)

  it("keeps the checkout across a Daytona stop and start", async () => {
    const externalId = await sandbox("persistence")
    const activeDriver = driver!
    await activeDriver.writeFile(externalId, `${workspace}/survives.txt`, "persistent\n")
    await activeDriver.stop(externalId)
    expect(await activeDriver.state(externalId)).toBe("stopped")
    await activeDriver.start(externalId)
    expect(await activeDriver.state(externalId)).toBe("started")
    expect(await activeDriver.readFile(externalId, `${workspace}/survives.txt`)).toBe(
      "persistent\n",
    )
  }, 600_000)

  it("serves a dev port through a signed Daytona preview URL", async () => {
    const externalId = await sandbox("preview")
    const activeDriver = driver!
    const started = await activeDriver.execStream(
      externalId,
      [
        "sh",
        "-c",
        `nohup node -e 'require("http").createServer((_,res)=>res.end("sprout-preview")).listen(3000,"0.0.0.0")' >/tmp/preview.log 2>&1 &`,
      ],
      30_000,
      () => {},
      () => {},
    )
    expect({ exitCode: started.exitCode, stderr: started.stderr }).toMatchObject({ exitCode: 0 })

    const local = await activeDriver.exec(
      externalId,
      ["curl", "--fail", "--silent", "http://127.0.0.1:3000"],
      30_000,
    )
    const previewLog = await activeDriver
      .readFile(externalId, "/tmp/preview.log")
      .catch(() => "no preview log")
    expect({ exitCode: local.exitCode, stderr: local.stderr, previewLog }).toMatchObject({
      exitCode: 0,
    })
    expect(local.stdout.trim()).toBe("sprout-preview")

    const preview = await activeDriver.previewUrl(externalId, 3000, 120)
    let response: Response | undefined
    for (let attempt = 0; attempt < 10; attempt += 1) {
      response = await fetch(preview.url).catch(() => undefined)
      if (response?.ok) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe("sprout-preview")
    expect(preview.expiresAt.getTime()).toBeGreaterThan(Date.now())
  }, 600_000)

  it("commits what the agent wrote and pushes it to a branch", async () => {
    const externalId = await sandbox("commit")
    const activeDriver = driver!
    const home = workspace.slice(0, workspace.lastIndexOf("/"))
    const origin = `${home}/origin.git`
    await activeDriver.exec(externalId, ["git", "init", "--bare", origin], 60_000)
    await activeDriver.exec(
      externalId,
      [
        "sh",
        "-c",
        `git -C ${workspace} init && git -C ${workspace} -c user.email=a@b -c user.name=A commit --allow-empty -m init && git -C ${workspace} push ${origin} HEAD:refs/heads/main`,
      ],
      120_000,
    )

    expect(
      await commitSandboxWork({
        author: { email: "dev@example.com", name: "Dev" },
        branch: "sproutos/agent-live",
        driver: activeDriver,
        externalId,
        message: "nothing",
        repository: "sproutos/test",
        token: "unused",
      }),
    ).toEqual({ committed: false, reason: "no_changes" })

    await activeDriver.writeFile(externalId, `${workspace}/app.ts`, "export const hello = 1\n")
    await activeDriver.writeFile(externalId, `${workspace}/notes.md`, "written by the agent\n")
    const pushed = await commitSandboxWork({
      author: { email: "dev@example.com", name: "Dev" },
      branch: "sproutos/agent-live",
      driver: activeDriver,
      externalId,
      message: "Add the agent's work",
      remote: origin,
      repository: "sproutos/test",
      token: "unused",
    })

    expect(pushed.committed).toBe(true)
    if (!pushed.committed) return
    expect(pushed.files.sort()).toEqual(["app.ts", "notes.md"])
    const remote = await activeDriver.exec(
      externalId,
      ["git", "--git-dir", origin, "rev-parse", "refs/heads/sproutos/agent-live"],
      60_000,
    )
    expect({ exitCode: remote.exitCode, stderr: remote.stderr }).toMatchObject({ exitCode: 0 })
    expect(remote.stdout.trim()).toBe(pushed.sha)
    const config = await activeDriver.readFile(externalId, `${workspace}/.git/config`)
    expect(config).not.toContain("extraheader")
    expect(config).not.toContain("x-access-token")
  }, 600_000)
})
