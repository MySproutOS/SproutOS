import {
  harnessFor,
  mintProxyToken,
  renderSproutosSkill,
  resolveAgentCredential,
  runSandboxTurn,
  SANDBOX_NETWORK_LAUNCHER,
  SANDBOX_NETWORK_LAUNCHER_SOURCE,
  upstreamKindFor,
  type AgentEvent,
} from "@lib/agent"
import { crudAgentProxyToken, crudAgentSession, crudSandbox } from "@lib/dao"
import { createGitHubClient, ensurePullRequest, type GitHubCredential } from "@lib/github"
import { sealForProxy } from "@lib/proxy-secret"
import { daytonaClientFromEnv, SNAPSHOT_RESOURCES, type DaytonaSandboxClient } from "@lib/sandbox"
import type { DB } from "@sproutos/db"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { meterSandboxes } from "./sandbox"

const exec = promisify(execFile)
const MAX_CONFLICT_FILES = 100
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const TURN_TIMEOUT_MS = 30 * 60 * 1000

export type UpstreamConflictInput = {
  db: Kysely<DB>
  projectJobId: string
  agentSessionId: string
  organizationId: string
  projectId: string
  userId: string
  owner: string
  repo: string
  branch: string
  provenance: string
  upstreamFullName: string
  upstreamBranch: string
  expectedTargetSha: string
  expectedUpstreamSha: string
  credential: GitHubCredential
  signal: AbortSignal
  touch?: () => Promise<void>
  mayPush?: () => Promise<void>
}

export type UpstreamConflictResolution = {
  pullRequestNumber: number
  pullRequestUrl: string
  proposedSha: string
  patchSha256: string
  files: string[]
}

export type UpstreamConflictDeps = {
  driver?: DaytonaSandboxClient
  beforePush?: () => Promise<void>
  targetUrl?: string
  upstreamUrl?: string
  ensurePr?: typeof ensurePullRequest
}

/** Agent-assisted resolution: Daytona returns only a bounded patch; the trusted host owns Git. */
export async function resolveUpstreamConflict(
  input: UpstreamConflictInput,
  deps: UpstreamConflictDeps = {},
): Promise<UpstreamConflictResolution> {
  const parentSignal = input.signal
  const deadline = new AbortController()
  const timeout = setTimeout(
    () => {
      deadline.abort(new Error("upstream resolution deadline exceeded"))
    },
    32 * 60 * 1000,
  )
  const abort = () => {
    deadline.abort(parentSignal.reason)
  }
  parentSignal.addEventListener("abort", abort, { once: true })
  input = { ...input, signal: deadline.signal }
  const directory = await mkdtemp(join(tmpdir(), "sproutos-upstream-resolution-"))
  const driver = deps.driver ?? daytonaClientFromEnv()
  let sandboxId: string | null = null
  let externalId: string | null = null

  try {
    const prepared = await prepareConflict(input, directory, deps)
    const persisted = await persistedResolution(input)
    if (persisted?.proposedSha) {
      const remote = await remoteBranchSha(input, prepared)
      if (remote === persisted.proposedSha)
        return await ensureResolutionPr(input, prepared, persisted, deps.ensurePr)
      if (persisted.patch) {
        return await finalizeConflict(
          input,
          directory,
          prepared,
          Buffer.from(persisted.patch, "base64").toString("utf8"),
          deps.beforePush,
          deps.ensurePr,
        )
      }
    }
    if (prepared.conflicts.length === 0)
      throw new Error("the recorded conflict no longer conflicts")
    if (prepared.conflicts.length > MAX_CONFLICT_FILES) {
      throw new Error(`the conflict touches more than ${MAX_CONFLICT_FILES} files`)
    }
    const contents = await Promise.all(
      prepared.conflicts.map(async (path) => ({
        path,
        content: await readConflictFile(directory, path),
      })),
    )
    const inputBytes = contents.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
    if (inputBytes > MAX_ARTIFACT_BYTES) throw new Error("the conflict artifact exceeds 2 MiB")
    if (contents.some((file) => file.content.includes("\0"))) {
      throw new Error("binary conflicts require manual resolution")
    }

    sandboxId = v7()
    await crudSandbox(input.db).create({
      id: sandboxId,
      projectId: input.projectId,
      userId: input.userId,
      provider: "daytona",
      purpose: "upstream_resolution",
      sandboxClass: "container",
      state: "starting",
      cpu: SNAPSHOT_RESOURCES.cpu,
      memoryGib: SNAPSHOT_RESOURCES.memoryGib,
      diskGib: SNAPSHOT_RESOURCES.diskGib,
      idleTimeoutS: 35 * 60,
      alwaysOn: false,
    })
    const created = await driver.create({
      sandboxId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      sandboxClass: "container",
      resources: SNAPSHOT_RESOURCES,
      alwaysOn: false,
      idleTimeoutS: 35 * 60,
    })
    externalId = created.externalId
    await crudSandbox(input.db).update(sandboxId, { externalId, state: "running" })

    await initializeResolutionSandbox(driver, externalId, contents, input)
    const patch = await runResolutionAgent(driver, externalId, sandboxId, input)
    if (Buffer.byteLength(patch) > MAX_ARTIFACT_BYTES) {
      throw new Error("the resolution patch exceeds 2 MiB")
    }

    // Daytona is destroyed before its output reaches trusted Git. No GitHub credential ever enters
    // the provider; the only returned artifact is this bounded binary patch.
    const meteringError = await destroyResolutionSandbox(input.db, driver, sandboxId, externalId)
    sandboxId = null
    externalId = null
    if (meteringError !== undefined) {
      throw meteringError instanceof Error
        ? meteringError
        : new Error("sandbox metering failed with a non-Error value")
    }

    const result = await finalizeConflict(
      input,
      directory,
      prepared,
      patch,
      deps.beforePush,
      deps.ensurePr,
    )
    return result
  } finally {
    if (sandboxId !== null && externalId !== null) {
      await destroyResolutionSandbox(input.db, driver, sandboxId, externalId).catch(
        (error: unknown) => {
          console.error(
            `[upkeep] failed to destroy resolution sandbox ${sandboxId}: ${String(error)}`,
          )
        },
      )
    } else if (sandboxId !== null) {
      await crudSandbox(input.db)
        .remove(sandboxId)
        .catch(() => undefined)
    }
    await rm(directory, { recursive: true, force: true })
    clearTimeout(timeout)
    parentSignal.removeEventListener("abort", abort)
  }
}

type PreparedConflict = {
  targetUrl: string
  targetSha: string
  upstreamSha: string
  conflicts: string[]
  branchName: string
}

async function prepareConflict(
  input: UpstreamConflictInput,
  directory: string,
  deps: UpstreamConflictDeps,
): Promise<PreparedConflict> {
  const targetUrl =
    deps.targetUrl ??
    `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git`
  const [upstreamOwner, upstreamRepo] = input.upstreamFullName.split("/")
  if (!upstreamOwner || !upstreamRepo) throw new Error("upstream is not owner/repo")
  const upstreamUrl =
    deps.upstreamUrl ??
    `https://github.com/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}.git`
  const targetEnv = gitAuthEnv(targetUrl, input.credential.token)
  await hostGit(directory, ["init", "--quiet"], undefined, [], input.signal)
  await hostGit(directory, ["remote", "add", "target", targetUrl], undefined, [], input.signal)
  await hostGit(directory, ["remote", "add", "upstream", upstreamUrl], undefined, [], input.signal)
  await hostGit(
    directory,
    [
      "fetch",
      "--quiet",
      "target",
      `+refs/heads/${input.branch}:refs/remotes/target/${input.branch}`,
    ],
    targetEnv,
    [],
    input.signal,
  )
  await hostGit(
    directory,
    [
      "fetch",
      "--quiet",
      "upstream",
      `+refs/heads/${input.upstreamBranch}:refs/remotes/upstream/${input.upstreamBranch}`,
    ],
    undefined,
    [],
    input.signal,
  )
  const targetSha = await rev(directory, `refs/remotes/target/${input.branch}`, input.signal)
  const upstreamSha = await rev(
    directory,
    `refs/remotes/upstream/${input.upstreamBranch}`,
    input.signal,
  )
  if (targetSha !== input.expectedTargetSha)
    throw new StaleUpstreamBaseError(input.expectedTargetSha, targetSha)
  if (upstreamSha !== input.expectedUpstreamSha)
    throw new StaleUpstreamBaseError(input.expectedUpstreamSha, upstreamSha)

  let baseSha = (
    await hostGit(directory, ["merge-base", targetSha, upstreamSha], undefined, [1], input.signal)
  ).stdout.trim()
  if (baseSha === "" && input.provenance === "template") {
    const roots = splitLines(
      (
        await hostGit(
          directory,
          ["rev-list", "--max-parents=0", targetSha],
          undefined,
          [],
          input.signal,
        )
      ).stdout,
    )
    if (roots.length !== 1) throw new Error("template conflict has more than one target root")
    const rootTree = (
      await hostGit(directory, ["show", "-s", "--format=%T", roots[0]], undefined, [], input.signal)
    ).stdout.trim()
    const match = splitLines(
      (
        await hostGit(
          directory,
          ["log", "--format=%H%x09%T", upstreamSha],
          undefined,
          [],
          input.signal,
        )
      ).stdout,
    )
      .map((line) => line.split("\t"))
      .find(([, tree]) => tree === rootTree)
    baseSha = match?.[0] ?? ""
  }
  if (baseSha === "") throw new Error("could not prove the conflict's merge base")

  const targetTree = (
    await hostGit(directory, ["show", "-s", "--format=%T", targetSha], undefined, [], input.signal)
  ).stdout.trim()
  const synthetic = (
    await hostGit(
      directory,
      [
        "-c",
        "user.name=SproutOS Upkeep",
        "-c",
        "user.email=upkeep@users.noreply.github.com",
        "commit-tree",
        targetTree,
        "-p",
        baseSha,
        "-m",
        "Synthetic conflict workspace",
      ],
      undefined,
      [],
      input.signal,
    )
  ).stdout.trim()
  await hostGit(
    directory,
    ["checkout", "--quiet", "--detach", synthetic],
    undefined,
    [],
    input.signal,
  )
  await hostGit(
    directory,
    ["merge", "--no-commit", "--no-ff", upstreamSha],
    undefined,
    [1],
    input.signal,
  )
  const conflicts = nul(
    (
      await hostGit(
        directory,
        ["diff", "--name-only", "--diff-filter=U", "-z"],
        undefined,
        [],
        input.signal,
      )
    ).stdout,
  )
  await hostGit(directory, ["add", "--", ...conflicts], undefined, [], input.signal)
  return {
    targetUrl,
    targetSha,
    upstreamSha,
    conflicts,
    branchName: `sproutos/upkeep-${input.projectJobId.slice(0, 8)}-${upstreamSha.slice(0, 12)}`,
  }
}

async function initializeResolutionSandbox(
  driver: DaytonaSandboxClient,
  externalId: string,
  files: { path: string; content: string }[],
  input: UpstreamConflictInput,
) {
  const workspace = driver.workspaceDir
  await driver.exec(externalId, ["git", "init", "--quiet", workspace], 60_000)
  for (const file of files) {
    await driver.exec(externalId, ["mkdir", "-p", dirname(`${workspace}/${file.path}`)], 60_000)
    await driver.writeFile(externalId, `${workspace}/${file.path}`, file.content)
  }
  await driver.writeFile(
    externalId,
    `${workspace}/.git/sproutos/codex/AGENTS.md`,
    renderSproutosSkill({
      apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me",
      tenantDomain: process.env.TENANT_DOMAIN ?? "sproutos.run",
      projectSlug: input.repo,
      workspacePath: workspace,
    }),
  )
  await driver.writeFile(
    externalId,
    `${workspace}/${SANDBOX_NETWORK_LAUNCHER}`,
    SANDBOX_NETWORK_LAUNCHER_SOURCE,
  )
  const add = await driver.exec(externalId, ["git", "-C", workspace, "add", "-A"], 60_000)
  if (add.exitCode !== 0) throw new Error(`could not stage conflict artifact: ${add.stderr}`)
  const commit = await driver.exec(
    externalId,
    [
      "git",
      "-C",
      workspace,
      "-c",
      "user.name=SproutOS Upkeep",
      "-c",
      "user.email=upkeep@users.noreply.github.com",
      "commit",
      "-m",
      "Unresolved upstream conflicts",
    ],
    60_000,
  )
  if (commit.exitCode !== 0) throw new Error(`could not commit conflict artifact: ${commit.stderr}`)
}

async function runResolutionAgent(
  driver: DaytonaSandboxClient,
  externalId: string,
  sandboxId: string,
  input: UpstreamConflictInput,
): Promise<string> {
  const credential = await resolveAgentCredential(input.db, input.organizationId, input.projectId)
  if (credential.billing === "none")
    throw new Error(`No usable agent credential: ${credential.reason}`)
  const proxy = await mintProxyToken(input.db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    agentCredentialId: credential.billing === "byo" ? credential.credentialId : null,
    upstreamKind: credential.billing === "byo" ? upstreamKindFor(credential.kind) : null,
    upstreamBaseUrl: credential.billing === "byo" ? credential.baseUrl : null,
    upstreamSecret: credential.billing === "byo" ? sealForProxy(credential.secret) : null,
  })
  const sessions = crudAgentSession(input.db)
  const prompt =
    "Resolve only the existing Git conflict markers. Do not add, delete, rename, commit, or push files. Preserve both upstream intent and the customer's changes."
  const turn = await sessions.openTurn({
    agentSessionId: input.agentSessionId,
    role: "user",
    inputText: prompt,
  })
  const events: { type: string; payload: AgentEvent; agentTurnId: string }[] = []
  let result
  try {
    result = await runSandboxTurn({
      driver,
      externalId,
      harness: credential.billing === "byo" ? harnessFor(credential.kind) : "codex",
      model: credential.model,
      prompt,
      proxyBaseUrl: process.env.LLM_PROXY_URL ?? "https://llm.sproutos.me",
      refreshUrl: `${process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me"}/v1/agent/proxy-token/refresh`,
      timeoutMs: TURN_TIMEOUT_MS,
      token: proxy,
      touch: async () => {
        await input.touch?.()
        await crudSandbox(input.db).touch(sandboxId)
      },
      onEvent: (event) => events.push({ type: event.type, payload: event, agentTurnId: turn.id }),
    })
  } finally {
    await crudAgentProxyToken(input.db).revoke(proxy.id)
  }
  await sessions.appendEvents(
    input.agentSessionId,
    await sessions.nextEventSeq(input.agentSessionId),
    events,
  )
  await sessions.closeTurn(turn.id, { resultSubtype: result.exitCode === 0 ? "resolved" : "error" })
  if (result.exitCode !== 0)
    throw new Error(`the conflict-resolution agent exited ${result.exitCode}`)
  const workspace = driver.workspaceDir
  const head = await driver.exec(externalId, ["git", "-C", workspace, "rev-parse", "HEAD"], 60_000)
  const parent = await driver.exec(
    externalId,
    ["git", "-C", workspace, "rev-parse", "HEAD^"],
    60_000,
  )
  if (parent.exitCode === 0) throw new Error("the agent committed instead of returning a patch")
  const diff = await driver.exec(
    externalId,
    ["git", "-C", workspace, "diff", "--binary", "--full-index", "HEAD", "--"],
    60_000,
  )
  if (head.exitCode !== 0 || diff.exitCode !== 0)
    throw new Error("could not read the resolution patch")
  return diff.stdout
}

type PersistedResolution = {
  proposedSha?: string
  patchSha256: string
  files: string[]
  patch?: string
}

async function currentDetails(input: UpstreamConflictInput): Promise<Record<string, unknown>> {
  const row = await input.db
    .selectFrom("projectJob")
    .select("details")
    .where("id", "=", input.projectJobId)
    .executeTakeFirstOrThrow()
  return typeof row.details === "object" && row.details !== null
    ? (row.details as Record<string, unknown>)
    : {}
}

async function persistedResolution(
  input: UpstreamConflictInput,
): Promise<PersistedResolution | null> {
  const details = await currentDetails(input)
  if (
    details.expectedTargetSha !== input.expectedTargetSha ||
    details.expectedUpstreamSha !== input.expectedUpstreamSha
  ) {
    throw new Error("project job authority does not match the requested conflict")
  }
  if (typeof details.proposedSha !== "string") return null
  return {
    proposedSha: details.proposedSha,
    patchSha256: typeof details.patchSha256 === "string" ? details.patchSha256 : "",
    files: Array.isArray(details.files)
      ? details.files.filter((value): value is string => typeof value === "string")
      : [],
    patch: typeof details.patch === "string" ? details.patch : undefined,
  }
}

async function remoteBranchSha(input: UpstreamConflictInput, prepared: PreparedConflict) {
  return (
    (
      await hostGit(
        tmpdir(),
        ["ls-remote", "--refs", prepared.targetUrl, `refs/heads/${prepared.branchName}`],
        gitAuthEnv(prepared.targetUrl, input.credential.token),
        [],
        input.signal,
      )
    ).stdout.split(/\s+/)[0] ?? ""
  )
}

async function ensureResolutionPr(
  input: UpstreamConflictInput,
  prepared: PreparedConflict,
  persisted: PersistedResolution,
  ensurePr: typeof ensurePullRequest = ensurePullRequest,
): Promise<UpstreamConflictResolution> {
  await input.mayPush?.()
  const pr = await ensurePr(createGitHubClient(), input.credential, {
    owner: input.owner,
    repo: input.repo,
    head: prepared.branchName,
    base: input.branch,
    title: `Resolve upstream update ${prepared.upstreamSha.slice(0, 12)}`,
    body: `Agent-assisted resolution of ${input.upstreamFullName}@${prepared.upstreamSha}.\n\nPatch SHA-256: \`${persisted.patchSha256}\``,
  })
  return {
    pullRequestNumber: pr.number,
    pullRequestUrl: pr.url,
    proposedSha: persisted.proposedSha ?? "",
    patchSha256: persisted.patchSha256,
    files: persisted.files,
  }
}

async function readConflictFile(directory: string, path: string): Promise<string> {
  try {
    return await readFile(join(directory, path), "utf8")
  } catch (error) {
    throw new Error(`delete/modify conflict for ${path} requires manual resolution`, {
      cause: error,
    })
  }
}

async function finalizeConflict(
  input: UpstreamConflictInput,
  directory: string,
  prepared: PreparedConflict,
  patch: string,
  beforePush?: () => Promise<void>,
  ensurePr: typeof ensurePullRequest = ensurePullRequest,
): Promise<UpstreamConflictResolution> {
  const patchPath = join(directory, ".git", "sproutos-resolution.patch")
  await writeFile(patchPath, patch)
  await hostGit(directory, ["apply", "--index", "--binary", patchPath], undefined, [], input.signal)
  await hostGit(directory, ["diff", "--cached", "--check"], undefined, [], input.signal)
  const files = nul(
    (
      await hostGit(
        directory,
        ["diff", "--cached", "--name-only", "-z", prepared.targetSha],
        undefined,
        [],
        input.signal,
      )
    ).stdout,
  )
  const allowed = new Set(prepared.conflicts)
  if (files.length === 0 || files.some((path) => !allowed.has(path)))
    throw new Error("the agent changed files outside the recorded conflict set")
  const tree = (await hostGit(directory, ["write-tree"], undefined, [], input.signal)).stdout.trim()
  const commitDate = (
    await hostGit(
      directory,
      ["show", "-s", "--format=%cI", prepared.upstreamSha],
      undefined,
      [],
      input.signal,
    )
  ).stdout.trim()
  const proposedSha = (
    await hostGit(
      directory,
      [
        "-c",
        "user.name=SproutOS Upkeep",
        "-c",
        "user.email=upkeep@users.noreply.github.com",
        "commit-tree",
        tree,
        "-p",
        prepared.targetSha,
        "-p",
        prepared.upstreamSha,
        "-m",
        `Resolve upstream ${prepared.upstreamSha.slice(0, 12)}`,
      ],
      { ...cleanEnv(), GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
      [],
      input.signal,
    )
  ).stdout.trim()
  const patchSha256 = createHash("sha256").update(patch).digest("hex")
  const priorDetails = await currentDetails(input)
  if (typeof priorDetails.proposedSha === "string" && priorDetails.proposedSha !== proposedSha) {
    throw new Error("persisted resolution does not reproduce its proposed commit")
  }
  await input.db
    .updateTable("projectJob")
    .set({
      details: {
        ...priorDetails,
        expectedTargetSha: prepared.targetSha,
        expectedUpstreamSha: prepared.upstreamSha,
        proposedSha,
        patchSha256,
        files,
        patch: Buffer.from(patch).toString("base64"),
      },
      updatedAt: new Date(),
    })
    .where("id", "=", input.projectJobId)
    .execute()
  await input.mayPush?.()
  await beforePush?.()
  const observed =
    (
      await hostGit(
        directory,
        ["ls-remote", "--refs", prepared.targetUrl, `refs/heads/${input.branch}`],
        gitAuthEnv(prepared.targetUrl, input.credential.token),
        [],
        input.signal,
      )
    ).stdout.split(/\s+/)[0] ?? ""
  if (observed !== prepared.targetSha)
    throw new StaleUpstreamBaseError(prepared.targetSha, observed)
  const branchRef = `refs/heads/${prepared.branchName}`
  const prior =
    (
      await hostGit(
        directory,
        ["ls-remote", "--refs", prepared.targetUrl, branchRef],
        gitAuthEnv(prepared.targetUrl, input.credential.token),
        [],
        input.signal,
      )
    ).stdout.split(/\s+/)[0] ?? ""
  await hostGit(
    directory,
    [
      "push",
      prepared.targetUrl,
      `${proposedSha}:${branchRef}`,
      `--force-with-lease=${branchRef}:${prior}`,
    ],
    gitAuthEnv(prepared.targetUrl, input.credential.token),
    [],
    input.signal,
  )
  const pr = await ensurePr(createGitHubClient(), input.credential, {
    owner: input.owner,
    repo: input.repo,
    head: prepared.branchName,
    base: input.branch,
    title: `Resolve upstream update ${prepared.upstreamSha.slice(0, 12)}`,
    body: `Agent-assisted resolution of ${input.upstreamFullName}@${prepared.upstreamSha}.\n\nPatch SHA-256: \`${patchSha256}\``,
  })
  return { pullRequestNumber: pr.number, pullRequestUrl: pr.url, proposedSha, patchSha256, files }
}

async function destroyResolutionSandbox(
  db: Kysely<DB>,
  driver: DaytonaSandboxClient,
  sandboxId: string,
  externalId: string,
) {
  let meteringError: unknown
  try {
    await meterSandboxes(
      {
        id: v7(),
        kind: "sandbox.meter",
        payload: {},
        attempt: 1,
        maxAttempts: 1,
        organizationId: null,
      },
      { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal },
    )
  } catch (error) {
    meteringError = error
  }
  try {
    await driver.destroy(externalId)
  } finally {
    await crudSandbox(db).remove(sandboxId)
  }
  return meteringError
}

async function hostGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  allowExit: readonly number[] = [],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
      {
        cwd,
        env: env ?? cleanEnv(),
        maxBuffer: MAX_ARTIFACT_BYTES,
        signal,
      },
    )
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null
    if (typeof code === "number" && allowExit.includes(code)) {
      const output = error as { stdout?: string | Buffer; stderr?: string | Buffer }
      return {
        stdout: String(output.stdout ?? ""),
        stderr: String(output.stderr ?? ""),
      }
    }
    throw error
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }
}
function gitAuthEnv(url: string, token: string): NodeJS.ProcessEnv {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  return {
    ...cleanEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  }
}
async function rev(cwd: string, ref: string, signal?: AbortSignal) {
  return (await hostGit(cwd, ["rev-parse", ref], undefined, [], signal)).stdout.trim()
}
function nul(value: string) {
  return value.split("\0").filter(Boolean)
}
function splitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export class StaleUpstreamBaseError extends Error {
  override readonly name = "StaleUpstreamBaseError"
  constructor(
    readonly expected: string,
    readonly observed: string,
  ) {
    super(`repository head changed: expected ${expected}, observed ${observed || "missing"}`)
  }
}
