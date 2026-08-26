import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"

import { dockerConfigFromEnv, dockerDriver } from "./docker"

const run = promisify(execFile)

/**
 * The sandbox, for real.
 *
 * Every other test in this repository that touches a sandbox uses a fake driver, which is fine for
 * the logic above it and proves nothing about whether a sandbox can exist. This one starts a
 * container, writes into it, runs commands in it, streams output out of it, and asks for a preview
 * URL — the operations `bootstrapSandbox` and `runSandboxTurn` are built out of.
 *
 * Skipped, loudly, when docker is not reachable. A developer without a daemon should not have a red
 * suite; a suite that silently passed without ever starting a container would be worse than either.
 */
const available = await (async () => {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

const config = dockerConfigFromEnv()
const driver = dockerDriver(config)
const created: string[] = []

afterAll(async () => {
  // Containers outlive the process that made them. A leaked one per run adds up on a laptop the
  // same way it adds up on a bill.
  for (const id of created) await driver.destroy(id).catch(() => {})
})

describe.skipIf(!available)("the docker sandbox driver, against a real daemon", () => {
  it("creates a container commands can actually run in", async () => {
    const sandbox = await driver.create({
      sandboxId: `test-${Date.now()}`,
      organizationId: "org",
      projectId: "project",
      userId: "user",
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
      env: { SPROUTOS_TEST: "yes" },
    })
    created.push(sandbox.externalId)

    const result = await driver.exec(
      sandbox.externalId,
      ["sh", "-c", "echo $SPROUTOS_TEST"],
      30_000,
    )
    expect(result.exitCode).toBe(0)
    // The environment reached the container. This is the mechanism the proxy token travels by.
    expect(result.stdout.trim()).toBe("yes")
  }, 120_000)

  it("writes a file whose content would break a shell argument", async () => {
    const sandbox = await driver.create({
      sandboxId: `test-quotes-${Date.now()}`,
      organizationId: "org",
      projectId: "project",
      userId: "user",
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
    })
    created.push(sandbox.externalId)

    /*
      The skill and `AGENTS.md` are markdown full of backticks and quotes. Writing them by
      interpolating into `sh -c "echo ... > path"` breaks on the first one — and is a command
      injection wearing a convenience's clothes, since the content is partly the customer's.
    */
    const nasty = `# It's "quoted" $(echo pwned) \`backtick\`\nand a second line\n`
    await driver.writeFile(sandbox.externalId, "/workspace/.claude/skills/x/SKILL.md", nasty)

    const read = await driver.readFile(sandbox.externalId, "/workspace/.claude/skills/x/SKILL.md")
    expect(read).toBe(nasty)
  }, 120_000)

  it("streams output while a command runs, and reports the exit code", async () => {
    const sandbox = await driver.create({
      sandboxId: `test-stream-${Date.now()}`,
      organizationId: "org",
      projectId: "project",
      userId: "user",
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
    })
    created.push(sandbox.externalId)

    const chunks: string[] = []
    const result = await driver.execStream(
      sandbox.externalId,
      ["sh", "-c", "echo one; echo two; exit 3"],
      30_000,
      (chunk) => chunks.push(chunk),
      () => {},
    )

    expect(chunks.join("")).toContain("one")
    expect(chunks.join("")).toContain("two")
    // The exit code is what tells a turn it failed. Resolving on `exit` rather than `close` would
    // drop the last chunks; reporting 0 for a crash would call a failed turn a success.
    expect(result.exitCode).toBe(3)
  }, 120_000)

  it("publishes a port a browser could load", async () => {
    const sandbox = await driver.create({
      sandboxId: `test-preview-${Date.now()}`,
      organizationId: "org",
      projectId: "project",
      userId: "user",
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
    })
    created.push(sandbox.externalId)

    const link = await driver.previewUrl(sandbox.externalId, 3000, 600)
    // The whole point of the preview tab: a URL the customer's own browser can open.
    expect(link.url).toMatch(/^http:\/\/localhost:\d+$/)
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now())
  }, 120_000)

  it("lists what is in the workspace", async () => {
    const sandbox = await driver.create({
      sandboxId: `test-tree-${Date.now()}`,
      organizationId: "org",
      projectId: "project",
      userId: "user",
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
    })
    created.push(sandbox.externalId)

    await driver.writeFile(sandbox.externalId, "/workspace/README.md", "hello")
    const entries = await driver.tree(sandbox.externalId)
    expect(entries.map((entry) => entry.path)).toContain("/workspace/README.md")
  }, 120_000)
})
