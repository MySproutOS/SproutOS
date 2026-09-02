import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { copyRepositorySnapshot } from "./repository-snapshot"

const exec = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    }),
  )
})

describe("copyRepositorySnapshot", () => {
  it("copies the current tree into one unrelated root commit and is retry-safe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sproutos-snapshot-test-"))
    directories.push(directory)
    const upstream = join(directory, "upstream.git")
    const target = join(directory, "target.git")
    const work = join(directory, "work")
    const checkout = join(directory, "checkout")
    await git(directory, ["init", "--bare", upstream])
    await git(directory, ["init", "--bare", target])
    await git(directory, ["init", "-b", "main", work])
    await writeFile(join(work, "README.md"), "first\n")
    await commit(work, "first")
    await writeFile(join(work, "README.md"), "current\n")
    await writeFile(join(work, "app.txt"), "snapshot\n")
    await commit(work, "current")
    await git(work, ["remote", "add", "origin", upstream])
    await git(work, ["push", "origin", "main"])

    const input = {
      owner: "target",
      repo: "copy",
      branch: "main",
      upstreamFullName: "source/app",
      upstreamBranch: "main",
      token: "unused-for-file-url",
      targetUrl: target,
      upstreamUrl: upstream,
    }
    const first = await copyRepositorySnapshot(input)
    expect(await copyRepositorySnapshot(input)).toBe(first)

    await git(directory, ["clone", "--quiet", "--branch", "main", target, checkout])
    expect((await git(checkout, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim()).toBe(first)
    expect((await git(checkout, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1")
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("current\n")
    expect(await readFile(join(checkout, "app.txt"), "utf8")).toBe("snapshot\n")
  })

  it("copies the exact signed commit after the upstream branch advances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sproutos-snapshot-pinned-test-"))
    directories.push(directory)
    const upstream = join(directory, "upstream.git")
    const target = join(directory, "target.git")
    const work = join(directory, "work")
    const checkout = join(directory, "checkout")
    await git(directory, ["init", "--bare", upstream])
    await git(directory, ["init", "--bare", target])
    await git(directory, ["init", "-b", "main", work])
    await writeFile(join(work, "README.md"), "signed\n")
    await commit(work, "signed")
    const signedCommit = (await git(work, ["rev-parse", "HEAD"])).stdout.trim()
    await writeFile(join(work, "README.md"), "moved\n")
    await commit(work, "moved")
    await git(work, ["remote", "add", "origin", upstream])
    await git(work, ["push", "origin", "main"])

    await copyRepositorySnapshot({
      owner: "target",
      repo: "copy",
      branch: "main",
      upstreamFullName: "source/app",
      upstreamBranch: "main",
      upstreamCommit: signedCommit,
      token: "unused-for-file-url",
      targetUrl: target,
      upstreamUrl: upstream,
    })

    await git(directory, ["clone", "--quiet", "--branch", "main", target, checkout])
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("signed\n")
    expect((await git(checkout, ["show", "-s", "--format=%s", "HEAD"])).stdout.trim()).toBe(
      `Initial snapshot of source/app@${signedCommit}`,
    )
  })

  it("rejects a malformed signed commit before fetching", async () => {
    await expect(
      copyRepositorySnapshot({
        owner: "target",
        repo: "copy",
        branch: "main",
        upstreamFullName: "source/app",
        upstreamBranch: "main",
        upstreamCommit: "main",
        token: "unused",
        targetUrl: "/unused/target.git",
        upstreamUrl: "/unused/upstream.git",
      }),
    ).rejects.toThrow("lowercase 40-character Git commit")
  })
})

async function commit(directory: string, message: string): Promise<void> {
  await git(directory, ["add", "."])
  await git(directory, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    message,
  ])
}

async function git(directory: string, args: string[]) {
  return await exec("git", args, { cwd: directory })
}
