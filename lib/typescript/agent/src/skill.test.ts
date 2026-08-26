import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installSproutosSkill } from "./skill"
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
    expect(body).toContain("sproutos.run")
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
