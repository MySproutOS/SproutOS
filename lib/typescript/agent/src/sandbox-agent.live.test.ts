import { afterAll, afterEach, describe, expect, it } from "vitest"

import {
  daytonaConfigFromEnv,
  daytonaClientFromEnv,
  SNAPSHOT_RESOURCES,
  type DaytonaSandboxClient,
} from "@lib/sandbox"

import { commitSandboxWork, runSandboxTurn } from "./sandbox-agent"
import { SANDBOX_NETWORK_LAUNCHER, SANDBOX_NETWORK_LAUNCHER_SOURCE } from "./sandbox-network"

/** This suite has no Docker substitute: every live assertion crosses Daytona's API. */
try {
  process.loadEnvFile()
} catch {
  // CI may supply variables directly, and a checkout may intentionally have no .env.
}

let driver: DaytonaSandboxClient | undefined
try {
  daytonaConfigFromEnv()
  driver = daytonaClientFromEnv()
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

async function sandbox(): Promise<string> {
  if (driver === undefined) throw new Error("Daytona is unavailable")
  const made = await driver.create({
    // Daytona's name remains visible through the label; the proxy username itself is a UUID.
    sandboxId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sandboxClass: "container",
    alwaysOn: false,
    resources: SNAPSHOT_RESOURCES,
    idleTimeoutS: 900,
  })
  created.push(made.externalId)
  return made.externalId
}

describe.skipIf(driver === undefined)("a Daytona sandbox", () => {
  it("streams and parses a harness turn through Daytona", async () => {
    const externalId = await sandbox()
    const activeDriver = driver!
    await activeDriver.writeFile(
      externalId,
      `${workspace}/${SANDBOX_NETWORK_LAUNCHER}`,
      SANDBOX_NETWORK_LAUNCHER_SOURCE,
    )
    await activeDriver.exec(externalId, ["mkdir", "-p", `${workspace}/.git/sproutos/codex`], 30_000)
    await activeDriver.writeFile(
      externalId,
      `${workspace}/.git/sproutos/codex/AGENTS.md`,
      "# SproutOS platform instructions\nVerify the delegated work.\n",
    )
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
      actionUrl: "https://api.sproutos.me/v1/agent/action",
      databaseBranchesUrl: "https://api.sproutos.me/v1/agent/database-branches",
      groupPrimaryCandidates: [],
      driver: activeDriver,
      externalId,
      harness: "claude-code",
      model: null,
      onEvent: (event) => events.push(event),
      prompt: "say hello",
      proxyBaseUrl: "https://llm.sproutos.me",
      projectSlug: "product-web",
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
    const externalId = await sandbox()
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
    const externalId = await sandbox()
    const activeDriver = driver!
    const started = await activeDriver.execStream(
      externalId,
      [
        "sh",
        "-c",
        `setsid -f node -e 'require("http").createServer((_,res)=>res.end("sprout-preview")).listen(3000,"0.0.0.0")' </dev/null >/tmp/preview.log 2>&1`,
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
    const externalId = await sandbox()
    const activeDriver = driver!
    const home = workspace.slice(0, workspace.lastIndexOf("/"))
    const origin = `${home}/origin.git`
    await activeDriver.exec(externalId, ["git", "init", "--bare", origin], 60_000)
    await activeDriver.exec(
      externalId,
      [
        "sh",
        "-c",
        `git -C ${workspace} init && git -C ${workspace} -c user.email=a@b -c user.name=A commit --allow-empty -m init && git -C ${workspace} push ${origin} HEAD:refs/heads/main && git -C ${workspace} update-ref refs/remotes/origin/main HEAD`,
      ],
      120_000,
    )

    expect(
      await commitSandboxWork({
        author: { email: "dev@example.com", name: "Dev" },
        baseBranch: "main",
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
      baseBranch: "main",
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
