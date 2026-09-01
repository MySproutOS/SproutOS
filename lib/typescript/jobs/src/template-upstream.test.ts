import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { assertSupportedTemplateGit, reconcileTemplateUpstream } from "./template-upstream"

const exec = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    })
  ).stdout.trim()
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "-A")
  await git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  )
  return await git(cwd, "rev-parse", "HEAD")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "template-upstream-test-"))
  directories.push(root)
  const upstreamWork = join(root, "upstream-work")
  const targetWork = join(root, "target-work")
  const upstreamBare = join(root, "upstream.git")
  const targetBare = join(root, "target.git")
  await mkdir(upstreamWork)
  await mkdir(targetWork)
  await git(upstreamWork, "init", "--initial-branch=main")
  await writeFile(join(upstreamWork, "app.txt"), "original\n")
  await writeFile(join(upstreamWork, "unchanged.txt"), "keep\n")
  const initialUpstreamSha = await commit(upstreamWork, "initial")
  await git(upstreamWork, "clone", "--bare", ".", upstreamBare)

  // GitHub template generation creates the same tree under a new, unrelated root commit.
  await git(targetWork, "init", "--initial-branch=main")
  await writeFile(join(targetWork, "app.txt"), "original\n")
  await writeFile(join(targetWork, "unchanged.txt"), "keep\n")
  await commit(targetWork, "generated from template")
  await git(targetWork, "clone", "--bare", ".", targetBare)

  return { root, upstreamWork, targetWork, upstreamBare, targetBare, initialUpstreamSha }
}

async function readTarget(targetBare: string, path: string): Promise<string> {
  return await git(targetBare, "show", `main:${path}`)
}

describe("reconcileTemplateUpstream", () => {
  it("accepts the Git 2.38 capability boundary and rejects 2.37", () => {
    expect(() => {
      assertSupportedTemplateGit("git version 2.38.0")
    }).not.toThrow()
    expect(() => {
      assertSupportedTemplateGit("git version 3.0.0")
    }).not.toThrow()
    expect(() => {
      assertSupportedTemplateGit("git version 2.37.9")
    }).toThrow(/2\.38 or newer/)
    expect(() => {
      assertSupportedTemplateGit("not git")
    }).toThrow(/found/)
  })

  it("finds the unrelated template root, applies a clean three-way merge, and preserves local work", async () => {
    const made = await fixture()
    await writeFile(join(made.targetWork, "customer.txt"), "mine\n")
    await commit(made.targetWork, "customer change")
    await git(made.targetWork, "push", made.targetBare, "main")

    await writeFile(join(made.upstreamWork, "app.txt"), "upstream v2\n")
    await writeFile(join(made.upstreamWork, "new.txt"), "new\n")
    await writeFile(join(made.upstreamWork, "line\nbreak.txt"), "odd but valid path\n")
    const upstreamSha = await commit(made.upstreamWork, "v2")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const result = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
    })

    expect(result).toMatchObject({ outcome: "merged", upstreamSha })
    expect(result.outcome === "merged" ? result.changedFiles.sort() : []).toEqual([
      "app.txt",
      "line\nbreak.txt",
      "new.txt",
    ])
    expect(await readTarget(made.targetBare, "app.txt")).toBe("upstream v2")
    expect(await readTarget(made.targetBare, "customer.txt")).toBe("mine")
  })

  it("reports exact conflicts and does not move the target branch", async () => {
    const made = await fixture()
    await writeFile(join(made.targetWork, "app.txt"), "customer edit\n")
    const targetSha = await commit(made.targetWork, "customer edit")
    await git(made.targetWork, "push", made.targetBare, "main")

    await writeFile(join(made.upstreamWork, "app.txt"), "upstream edit\n")
    await commit(made.upstreamWork, "upstream edit")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const result = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
    })

    expect(result).toMatchObject({ outcome: "conflict", conflicts: ["app.txt"] })
    expect(await git(made.targetBare, "rev-parse", "main")).toBe(targetSha)
  })

  it("uses the real three-way merger for non-overlapping edits in the same file", async () => {
    const made = await fixture()
    await writeFile(join(made.upstreamWork, "app.txt"), "first\nsecond\nthird\n")
    const shared = await commit(made.upstreamWork, "three lines")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    // Recreate the generated copy from that exact upstream tree, under an unrelated root.
    await writeFile(join(made.targetWork, "app.txt"), "first\nsecond\nthird\n")
    await commit(made.targetWork, "template refresh")
    await git(made.targetWork, "push", made.targetBare, "main")

    await writeFile(join(made.targetWork, "app.txt"), "customer first\nsecond\nthird\n")
    await commit(made.targetWork, "customer edits first line")
    await git(made.targetWork, "push", made.targetBare, "main")
    await writeFile(join(made.upstreamWork, "app.txt"), "first\nsecond\nupstream third\n")
    await commit(made.upstreamWork, "upstream edits third line")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const result = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
      baseUpstreamSha: shared,
    })

    expect(result.outcome).toBe("merged")
    expect(await readTarget(made.targetBare, "app.txt")).toBe(
      "customer first\nsecond\nupstream third",
    )
  })

  it("uses the recorded upstream SHA on later runs and is idempotent", async () => {
    const made = await fixture()
    await writeFile(join(made.upstreamWork, "new.txt"), "new\n")
    const upstreamSha = await commit(made.upstreamWork, "v2")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const first = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
      baseUpstreamSha: made.initialUpstreamSha,
    })
    expect(first.outcome).toBe("merged")
    const firstHead = await git(made.targetBare, "rev-parse", "main")

    const second = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
      baseUpstreamSha: upstreamSha,
    })
    expect(second).toMatchObject({ outcome: "up_to_date", upstreamSha })
    expect(await git(made.targetBare, "rev-parse", "main")).toBe(firstHead)
    expect(await readFile(join(made.upstreamWork, "new.txt"), "utf8")).toBe("new\n")
  })

  it("creates the same commit for the same target and upstream inputs", async () => {
    const made = await fixture()
    const originalTarget = await git(made.targetBare, "rev-parse", "main")
    await writeFile(join(made.upstreamWork, "new.txt"), "new\n")
    await commit(made.upstreamWork, "v2")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const input = {
      owner: "customer",
      repo: "copy",
      branch: "main",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
      baseUpstreamSha: made.initialUpstreamSha,
    }
    const first = await reconcileTemplateUpstream(input)
    expect(first.outcome).toBe("merged")
    await git(made.targetBare, "update-ref", "refs/heads/main", originalTarget)
    const second = await reconcileTemplateUpstream(input)
    expect(second.outcome).toBe("merged")
    expect(second.outcome === "merged" && first.outcome === "merged" && second.mergeSha).toBe(
      first.outcome === "merged" ? first.mergeSha : "",
    )
  })

  it("pushes a proposal branch without moving the production branch", async () => {
    const made = await fixture()
    const originalTarget = await git(made.targetBare, "rev-parse", "main")
    await writeFile(join(made.upstreamWork, "new.txt"), "new\n")
    await commit(made.upstreamWork, "v2")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    const result = await reconcileTemplateUpstream({
      owner: "customer",
      repo: "copy",
      branch: "main",
      updateBranch: "sproutos/upkeep-proposal",
      upstreamFullName: "catalogue/template",
      upstreamBranch: "main",
      token: "not-used-for-local-remotes",
      targetUrl: made.targetBare,
      upstreamUrl: made.upstreamBare,
      baseUpstreamSha: made.initialUpstreamSha,
    })
    expect(result.outcome).toBe("merged")
    expect(await git(made.targetBare, "rev-parse", "main")).toBe(originalTarget)
    expect(await git(made.targetBare, "show", "sproutos/upkeep-proposal:new.txt")).toBe("new")
  })

  it("refuses to overwrite a commit pushed after the target was fetched", async () => {
    const made = await fixture()
    await writeFile(join(made.upstreamWork, "new.txt"), "new\n")
    await commit(made.upstreamWork, "v2")
    await git(made.upstreamWork, "push", made.upstreamBare, "main")

    await expect(
      reconcileTemplateUpstream({
        owner: "customer",
        repo: "copy",
        branch: "main",
        upstreamFullName: "catalogue/template",
        upstreamBranch: "main",
        token: "not-used-for-local-remotes",
        targetUrl: made.targetBare,
        upstreamUrl: made.upstreamBare,
        baseUpstreamSha: made.initialUpstreamSha,
        beforePush: async () => {
          await writeFile(join(made.targetWork, "racing.txt"), "racing push\n")
          await commit(made.targetWork, "racing push")
          await git(made.targetWork, "push", made.targetBare, "main")
        },
      }),
    ).rejects.toThrow("failed to push")

    expect(await readTarget(made.targetBare, "racing.txt")).toBe("racing push")
    await expect(git(made.targetBare, "show", "main:new.txt")).rejects.toThrow("Command failed")
  })

  it("refuses to overwrite a copy whose root cannot be proven to come from upstream", async () => {
    const made = await fixture()
    await writeFile(join(made.targetWork, "app.txt"), "not the template snapshot\n")
    await git(made.targetWork, "checkout", "--orphan", "replacement")
    await git(made.targetWork, "rm", "-rf", ".")
    await writeFile(join(made.targetWork, "other.txt"), "unrelated\n")
    await commit(made.targetWork, "unrelated root")
    await git(made.targetWork, "push", made.targetBare, "HEAD:main", "--force")

    await expect(
      reconcileTemplateUpstream({
        owner: "customer",
        repo: "copy",
        branch: "main",
        upstreamFullName: "catalogue/template",
        upstreamBranch: "main",
        token: "not-used-for-local-remotes",
        targetUrl: made.targetBare,
        upstreamUrl: made.upstreamBare,
      }),
    ).rejects.toThrow(/refusing a two-way overwrite/)
  })
})
