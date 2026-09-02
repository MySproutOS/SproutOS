import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { branchPushLease } from "./commit"
import type { Workspace } from "./workspace"

const run = promisify(execFile)
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function checkoutFixture(): Promise<{ workspace: Workspace; sha: string }> {
  const origin = await mkdtemp(join(tmpdir(), "sproutos-commit-origin-"))
  const checkout = await mkdtemp(join(tmpdir(), "sproutos-commit-checkout-"))
  temporaryPaths.push(origin, checkout)
  await run("git", ["init", "--bare", "--initial-branch", "main", origin])

  const seed = await mkdtemp(join(tmpdir(), "sproutos-commit-seed-"))
  temporaryPaths.push(seed)
  await run("git", ["init", "--initial-branch", "main", seed])
  await writeFile(join(seed, "README.md"), "# fixture\n")
  await run("git", ["-C", seed, "add", "README.md"])
  await run("git", [
    "-C",
    seed,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@test.invalid",
    "commit",
    "-m",
    "initial",
  ])
  await run("git", ["-C", seed, "push", origin, "main"])
  const { stdout: sha } = await run("git", ["-C", seed, "rev-parse", "HEAD"])
  await run("git", ["clone", "--depth", "1", "--branch", "main", origin, checkout])
  return { workspace: { path: checkout, dispose: async () => {} }, sha: sha.trim() }
}

describe("branchPushLease", () => {
  it("pins a URL push to the branch head observed by the clone", async () => {
    const fixture = await checkoutFixture()
    await expect(branchPushLease(fixture.workspace, "main")).resolves.toBe(
      `--force-with-lease=refs/heads/main:${fixture.sha}`,
    )
  })

  it("requires an unobserved destination branch to be absent", async () => {
    const fixture = await checkoutFixture()
    await expect(branchPushLease(fixture.workspace, "sproutos/new")).resolves.toBe(
      "--force-with-lease=refs/heads/sproutos/new:",
    )
  })
})
