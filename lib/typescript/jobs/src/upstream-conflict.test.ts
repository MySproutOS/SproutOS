/* oxlint-disable typescript/require-await, typescript/no-unsafe-assignment, vitest/require-mock-type-parameters -- async provider and matcher test doubles mirror production interfaces */
import { ensurePullRequest, installationToken, type PullRequestResult } from "@lib/github"
import type { CreateSandboxInput, DaytonaSandboxClient, ExecResult, TreeEntry } from "@lib/sandbox"
import { db, type JsonObject } from "@sproutos/db"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  resolveUpstreamConflict,
  StaleUpstreamBaseError,
  type UpstreamConflictDeps,
  type UpstreamConflictInput,
} from "./upstream-conflict"

const run = promisify(execFile)
const directories: string[] = []
const users: string[] = []
const organizations: string[] = []

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await run("git", args, {
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

async function repositories() {
  const root = await mkdtemp(join(tmpdir(), "upstream-conflict-test-"))
  directories.push(root)
  const upstreamWork = join(root, "upstream-work")
  const upstreamBare = join(root, "upstream.git")
  const targetWork = join(root, "target-work")
  const targetBare = join(root, "target.git")
  await mkdir(upstreamWork)
  await git(upstreamWork, "init", "--initial-branch=main")
  await writeFile(join(upstreamWork, "app.txt"), "shared\n")
  await writeFile(join(upstreamWork, "safe.txt"), "unchanged\n")
  await commit(upstreamWork, "shared base")
  await git(upstreamWork, "clone", ".", targetWork)
  await git(upstreamWork, "clone", "--bare", ".", upstreamBare)

  await writeFile(join(targetWork, "app.txt"), "customer\n")
  const targetSha = await commit(targetWork, "customer edit")
  await git(targetWork, "clone", "--bare", ".", targetBare)

  await writeFile(join(upstreamWork, "app.txt"), "upstream\n")
  const upstreamSha = await commit(upstreamWork, "upstream edit")
  await git(upstreamWork, "push", upstreamBare, "main")
  return { root, upstreamWork, upstreamBare, targetWork, targetBare, targetSha, upstreamSha }
}

async function seed(projectJobDetails: JsonObject) {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const sessionId = v7()
  const projectJobId = v7()
  const suffix = repositoryId.slice(-12)
  await db
    .insertInto("user")
    .values({ id: userId, email: `conflict-${suffix}@example.test`, name: "Resolver" })
    .execute()
  users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `conflict-${suffix}`,
      name: "Conflict",
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  organizations.push(organizationId)
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "customer",
      name: `app-${suffix}`,
      defaultBranch: "main",
      provenance: "fork",
      isFork: true,
      upstreamFullName: "upstream/app",
      upstreamDefaultBranch: "main",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "App",
      slug: `app-${suffix}`,
    })
    .execute()
  await db
    .insertInto("agentConfig")
    .values({
      id: v7(),
      scope: "project",
      projectId,
      useSproutosCredits: true,
      permissionMode: "accept_edits",
    })
    .execute()
  await db
    .insertInto("agentSession")
    .values({ id: sessionId, projectId, createdByUserId: userId, title: "Resolve upstream" })
    .execute()
  await db
    .insertInto("projectJob")
    .values({
      id: projectJobId,
      organizationId,
      projectId,
      repositoryId,
      kind: "sync_upstream",
      state: "running",
      details: projectJobDetails,
    })
    .execute()
  return { userId, organizationId, repositoryId, projectId, sessionId, projectJobId }
}

type DriverOptions = {
  resolved?: string
  exitCode?: number
}

function fakeDriver(root: string, options: DriverOptions = {}) {
  const workspaceDir = join(root, "sandbox-workspace")
  const destroyed: string[] = []
  const created: CreateSandboxInput[] = []
  const secretEnvironments: Record<string, string>[] = []

  async function execute(argv: string[]): Promise<ExecResult> {
    try {
      const result = await run(argv[0], argv.slice(1), {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; code?: number }
      return {
        stdout: String(value.stdout ?? ""),
        stderr: String(value.stderr ?? ""),
        exitCode: typeof value.code === "number" ? value.code : 1,
      }
    }
  }

  const driver: DaytonaSandboxClient = {
    workspaceDir,
    async create(input) {
      created.push(input)
      await mkdir(workspaceDir, { recursive: true })
      return { externalId: `daytona-${input.sandboxId}` }
    },
    state: () => Promise.resolve("started"),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    async destroy(externalId) {
      destroyed.push(externalId)
      await rm(workspaceDir, { recursive: true, force: true })
    },
    cloneRepository: () => Promise.reject(new Error("cloneRepository is not used")),
    exec: (_externalId, argv) => execute(argv),
    execStream: () => Promise.reject(new Error("execStream is not used")),
    async execStreamWithSecrets(_externalId, _argv, env, _timeout, onStdout) {
      secretEnvironments.push(env)
      if ((options.exitCode ?? 0) === 0) {
        await writeFile(join(workspaceDir, "app.txt"), options.resolved ?? "resolved\n")
        onStdout("")
      }
      return { stdout: "", stderr: "", exitCode: options.exitCode ?? 0 }
    },
    readFile: (_externalId, path) => readFile(path, "utf8"),
    async writeFile(_externalId, path, content) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    },
    tree: () => Promise.resolve([] as TreeEntry[]),
    previewUrl: () => Promise.resolve({ url: "https://example.test", expiresAt: new Date() }),
    touch: () => Promise.resolve(),
  }
  return { driver, created, destroyed, secretEnvironments }
}

function input(
  seeded: Awaited<ReturnType<typeof seed>>,
  repos: Awaited<ReturnType<typeof repositories>>,
  overrides: Partial<UpstreamConflictInput> = {},
): UpstreamConflictInput {
  return {
    db,
    projectJobId: seeded.projectJobId,
    agentSessionId: seeded.sessionId,
    organizationId: seeded.organizationId,
    projectId: seeded.projectId,
    userId: seeded.userId,
    owner: "customer",
    repo: "app",
    branch: "main",
    provenance: "fork",
    upstreamFullName: "upstream/app",
    upstreamBranch: "main",
    expectedTargetSha: repos.targetSha,
    expectedUpstreamSha: repos.upstreamSha,
    credential: installationToken("git-token", 1, new Date(Date.now() + 60_000)),
    signal: new AbortController().signal,
    ...overrides,
  }
}

function dependencies(
  repos: Awaited<ReturnType<typeof repositories>>,
  driver: DaytonaSandboxClient,
  ensurePr: NonNullable<UpstreamConflictDeps["ensurePr"]> = vi.fn(
    async (..._args: Parameters<typeof ensurePullRequest>): Promise<PullRequestResult> => ({
      number: 17,
      url: "https://github.com/customer/app/pull/17",
    }),
  ),
): UpstreamConflictDeps {
  return {
    driver,
    targetUrl: repos.targetBare,
    upstreamUrl: repos.upstreamBare,
    ensurePr,
  }
}

async function branchSha(repo: string, projectJobId: string, upstreamSha: string) {
  const branch = `sproutos/upkeep-${projectJobId.slice(0, 8)}-${upstreamSha.slice(0, 12)}`
  try {
    return await git(repo, "rev-parse", `refs/heads/${branch}`)
  } catch {
    return null
  }
}

afterEach(async () => {
  for (const id of organizations.splice(0)) {
    await db.deleteFrom("organization").where("id", "=", id).execute()
  }
  for (const id of users.splice(0)) {
    await db.deleteFrom("user").where("id", "=", id).execute()
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

afterAll(async () => {
  await db.destroy()
})

describe.skipIf(!reachable)("resolveUpstreamConflict", () => {
  it("refuses a stale target before renting a sandbox or pushing", async () => {
    const repos = await repositories()
    const seeded = await seed({
      expectedTargetSha: "0".repeat(40),
      expectedUpstreamSha: repos.upstreamSha,
    })
    const fake = fakeDriver(repos.root)

    await expect(
      resolveUpstreamConflict(
        input(seeded, repos, { expectedTargetSha: "0".repeat(40) }),
        dependencies(repos, fake.driver),
      ),
    ).rejects.toBeInstanceOf(StaleUpstreamBaseError)

    expect(fake.created).toEqual([])
    expect(await branchSha(repos.targetBare, seeded.projectJobId, repos.upstreamSha)).toBeNull()
  })

  it("does not push when the agent fails, and always destroys its sandbox and revokes its token", async () => {
    const repos = await repositories()
    const seeded = await seed({
      expectedTargetSha: repos.targetSha,
      expectedUpstreamSha: repos.upstreamSha,
    })
    const fake = fakeDriver(repos.root, { exitCode: 1 })
    const ensurePr = vi.fn()

    await expect(
      resolveUpstreamConflict(input(seeded, repos), dependencies(repos, fake.driver, ensurePr)),
    ).rejects.toThrow("agent exited 1")

    expect(ensurePr).not.toHaveBeenCalled()
    expect(fake.created).toHaveLength(1)
    expect(fake.destroyed).toHaveLength(1)
    expect(await branchSha(repos.targetBare, seeded.projectJobId, repos.upstreamSha)).toBeNull()
    expect(
      await db
        .selectFrom("sandbox")
        .select("id")
        .where("projectId", "=", seeded.projectId)
        .execute(),
    ).toEqual([])
    const tokens = await db
      .selectFrom("agentProxyToken")
      .select("revokedAt")
      .where("projectId", "=", seeded.projectId)
      .execute()
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.revokedAt).not.toBeNull()
  })

  it("pushes one exact two-parent merge commit and opens the PR from trusted code", async () => {
    const repos = await repositories()
    const seeded = await seed({
      expectedTargetSha: repos.targetSha,
      expectedUpstreamSha: repos.upstreamSha,
    })
    const fake = fakeDriver(repos.root)
    const ensurePr = vi.fn(
      async (..._args: Parameters<typeof ensurePullRequest>): Promise<PullRequestResult> => ({
        number: 17,
        url: "https://github.com/customer/app/pull/17",
      }),
    )

    const result = await resolveUpstreamConflict(
      input(seeded, repos),
      dependencies(repos, fake.driver, ensurePr),
    )

    expect(result).toMatchObject({ pullRequestNumber: 17, files: ["app.txt"] })
    const proposed = await branchSha(repos.targetBare, seeded.projectJobId, repos.upstreamSha)
    expect(proposed).toBe(result.proposedSha)
    expect(
      (await git(repos.targetBare, "show", "-s", "--format=%P", proposed!)).split(" "),
    ).toEqual([repos.targetSha, repos.upstreamSha])
    expect(await git(repos.targetBare, "show", `${proposed}:app.txt`)).toBe("resolved")
    expect(await git(repos.targetBare, "rev-parse", "main")).toBe(repos.targetSha)
    expect(ensurePr).toHaveBeenCalledOnce()
    expect(ensurePr.mock.calls[0]?.[2]).toMatchObject({
      base: "main",
      head: `sproutos/upkeep-${seeded.projectJobId.slice(0, 8)}-${repos.upstreamSha.slice(0, 12)}`,
    })
    expect(fake.destroyed).toHaveLength(1)
    expect(fake.secretEnvironments).toHaveLength(1)
    expect(JSON.stringify(fake.secretEnvironments)).not.toContain("git-token")
  })

  it("refuses the exact target-head race after persisting a reproducible proposal", async () => {
    const repos = await repositories()
    const seeded = await seed({
      expectedTargetSha: repos.targetSha,
      expectedUpstreamSha: repos.upstreamSha,
    })
    const fake = fakeDriver(repos.root)
    const ensurePr = vi.fn()

    await expect(
      resolveUpstreamConflict(input(seeded, repos), {
        ...dependencies(repos, fake.driver, ensurePr),
        beforePush: async () => {
          await writeFile(join(repos.targetWork, "racing.txt"), "racing\n")
          await commit(repos.targetWork, "racing target push")
          await git(repos.targetWork, "push", repos.targetBare, "main")
        },
      }),
    ).rejects.toBeInstanceOf(StaleUpstreamBaseError)

    expect(ensurePr).not.toHaveBeenCalled()
    expect(await git(repos.targetBare, "show", "main:racing.txt")).toBe("racing")
    expect(await branchSha(repos.targetBare, seeded.projectJobId, repos.upstreamSha)).toBeNull()
    const details = await db
      .selectFrom("projectJob")
      .select("details")
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(details.details).toMatchObject({
      expectedTargetSha: repos.targetSha,
      expectedUpstreamSha: repos.upstreamSha,
      proposedSha: expect.any(String),
      patchSha256: expect.any(String),
      patch: expect.any(String),
    })
  })

  it("recovers a pushed proposal without renting a second sandbox or changing its SHA", async () => {
    const repos = await repositories()
    const seeded = await seed({
      expectedTargetSha: repos.targetSha,
      expectedUpstreamSha: repos.upstreamSha,
    })
    const firstDriver = fakeDriver(repos.root)
    const firstPr = vi.fn(
      async (..._args: Parameters<typeof ensurePullRequest>): Promise<PullRequestResult> => ({
        number: 17,
        url: "https://github.com/customer/app/pull/17",
      }),
    )
    const first = await resolveUpstreamConflict(
      input(seeded, repos),
      dependencies(repos, firstDriver.driver, firstPr),
    )
    const retryDriver = fakeDriver(repos.root)
    const retryPr = vi.fn(
      async (..._args: Parameters<typeof ensurePullRequest>): Promise<PullRequestResult> => ({
        number: 17,
        url: "https://github.com/customer/app/pull/17",
      }),
    )

    const retried = await resolveUpstreamConflict(
      input(seeded, repos),
      dependencies(repos, retryDriver.driver, retryPr),
    )

    expect(retried.proposedSha).toBe(first.proposedSha)
    expect(retried.patchSha256).toBe(first.patchSha256)
    expect(retryDriver.created).toEqual([])
    expect(retryPr).toHaveBeenCalledOnce()
    expect(await branchSha(repos.targetBare, seeded.projectJobId, repos.upstreamSha)).toBe(
      first.proposedSha,
    )
  })
})
