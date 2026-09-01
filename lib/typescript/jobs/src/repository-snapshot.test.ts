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
