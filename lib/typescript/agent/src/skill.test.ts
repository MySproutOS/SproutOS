import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installSproutosSkill, renderPublicSproutosSkill, renderSproutosSkill } from "./skill"
import type { Workspace } from "./workspace"

const run = promisify(execFile)

/**
 * A real repository, because the property under test is a git property.
 *
 * Asserting that `.git/info/exclude` contains a line would test that the function writes a string.
 * What matters is whether `git add -A` picks the skill up, and only git can answer that.
 */
describe("installSproutosSkill", () => {
  let workspace: Workspace

  beforeEach(async () => {
    const path = await mkdtemp(join(tmpdir(), "skill-test-"))
    await run("git", ["-C", path, "init", "-q"])
    await writeFile(join(path, "README.md"), "# app\n")
    workspace = { path, dispose: async () => rm(path, { recursive: true, force: true }) }
  })

  afterEach(async () => {
    await workspace.dispose()
  })

  const input = {
    apiUrl: "https://api.sproutos.me",
    tenantDomain: "sproutos.run",
    projectSlug: "reddit-clone-web",
  }

  it("writes a skill the agent can read", async () => {
    await installSproutosSkill({ workspace, ...input })

    const body = await readFile(join(workspace.path, ".claude/skills/sproutos/SKILL.md"), "utf8")
    expect(body).toContain("name: sproutos")
    // The project is interpolated so the snippet is copy-pasteable, not a form to fill in.
    expect(body).toContain("project: reddit-clone-web")
    expect(body).toContain("sprout deploy reddit-clone-web")
    expect(body).toContain("MySproutOS/Deployment-Templates")
    expect(body).toContain("cli-v0.1.0")
    expect(body).toContain("0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180")
    expect(body).toContain("c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1")
    expect(body).toContain("ELASTICSEARCH_URL")
    expect(body).toContain("queue.drain")
    expect(body).toContain("sproutos.run")
    expect(body).toContain("Choose the group's customer-facing project")
    expect(body).toContain("SPROUTOS_AGENT_GROUP_PRIMARY_URL")
    expect(body).toContain("SPROUTOS_AGENT_ACTION_TOKEN")
    expect(body).toContain("primaryProjectSlug")
    expect(body).toContain("project has no group primary and is refused")
  })

  /** The one that matters: the platform must not commit its own scaffolding into a user's repo. */
  it("stays out of `git add -A`", async () => {
    await installSproutosSkill({ workspace, ...input })
    await run("git", ["-C", workspace.path, "add", "-A"])

    const { stdout } = await run("git", ["-C", workspace.path, "diff", "--cached", "--name-only"])
    const staged = stdout.split("\n").filter((line) => line !== "")

    expect(staged).toContain("README.md")
    expect(staged.some((path) => path.includes(".claude/skills/sproutos"))).toBe(false)
  })

  it("does not touch a tracked .gitignore", async () => {
    await writeFile(join(workspace.path, ".gitignore"), "node_modules\n")
    await installSproutosSkill({ workspace, ...input })

    // Editing .gitignore would itself be a commit into the customer's repository.
    expect(await readFile(join(workspace.path, ".gitignore"), "utf8")).toBe("node_modules\n")
  })

  it("is idempotent across turns", async () => {
    await installSproutosSkill({ workspace, ...input })
    await installSproutosSkill({ workspace, ...input })

    const exclude = await readFile(join(workspace.path, ".git/info/exclude"), "utf8")
    const occurrences = exclude.split("/.claude/skills/sproutos/").length - 1
    expect(occurrences).toBe(1)
  })
})

describe("the sandbox's own section", () => {
  const input = {
    apiUrl: "https://api.sproutos.me",
    projectSlug: "reddit-web",
    tenantDomain: "sproutos.run",
    workspacePath: "/home/daytona/workspace",
  }

  it("tells the agent what is true of the machine it is on", () => {
    const body = renderSproutosSkill(input)

    // The three facts that change what the agent does, rather than what it knows.
    expect(body).toContain("DATABASE_URL")
    expect(body).toContain("0.0.0.0")
    expect(body).toContain("/home/daytona/workspace")
    expect(body).toContain("setsid -f")
    expect(body).toContain("run_in_background")
    expect(body).toContain("Every public HTTP(S) domain is allowed")
    expect(body).toContain("Whenever you need")
    expect(body).toContain("Do not unset, override, or bypass the proxy variables")
    expect(body).toContain("configure that tool to use the existing proxy")
    expect(body).toContain("metadata addresses")
    expect(body).toContain("committed and pushed to a branch")
    expect(body).toContain("fifteen minutes")
    expect(body).toContain("## Delegating work")
    expect(body).toContain("at most two children concurrently")
    expect(body).toContain("`small` role")
    expect(body).toContain("`large` role")
    expect(body).toContain("The parent agent owns the final answer")
  })

  it("says none of it in the control-plane checkout, where none of it is true", async () => {
    /*
      That checkout has no database, no port anybody can reach, and `Bash` refused outright. Telling
      an agent there that it may start a dev server is an instruction it cannot carry out — and the
      failure would read as the model ignoring the skill.
    */
    const workspace = await mkdtemp(join(tmpdir(), "skill-"))
    try {
      await installSproutosSkill({ ...input, workspace: { path: workspace } as never })
      const written = await readFile(join(workspace, ".claude/skills/sproutos/SKILL.md"), "utf8")
      expect(written).not.toContain("Where you are right now")
      expect(written).toContain("Deploying this repository on SproutOS")
      expect(written).toContain("~/.codex/skills/sproutos/SKILL.md")
      expect(written).not.toContain("SPROUT_OS_DEPLOY")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("the public skill", () => {
  it("uses the deployment source without claiming the developer is inside a sandbox", () => {
    const body = renderPublicSproutosSkill({
      apiUrl: "https://api.sproutos.me",
      tenantDomain: "sproutos.run",
    })

    expect(body).toContain(
      "MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180",
    )
    expect(body).not.toContain("sproutos-deploy-action@v1")
    expect(body).toContain("AGENTS.md-only harness")
    expect(body).toContain("~/.codex/skills/sproutos/SKILL.md")
    expect(body).not.toContain("Where you are right now")
  })
})
