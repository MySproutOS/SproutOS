import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export type TemplateUpstreamInput = {
  owner: string
  repo: string
  branch: string
  /** Destination branch for the proposed update. The source `branch` remains untouched. */
  updateBranch?: string
  upstreamFullName: string
  upstreamBranch: string
  /** Refuse to propose a different upstream commit than the one the scheduler inspected. */
  expectedUpstreamSha?: string
  token: string
  /** The upstream commit recorded by the last successful reconciliation, when one exists. */
  baseUpstreamSha?: string | null
  signal?: AbortSignal
  /** Test seams. Production always uses the credential-free GitHub URLs. */
  targetUrl?: string
  upstreamUrl?: string
  /** Test seam used to prove the remote-head lease. */
  beforePush?: () => Promise<void>
}

export type TemplateUpstreamResult =
  | {
      outcome: "up_to_date"
      upstreamSha: string
      targetSha: string
      behindBy: number
      aheadBy: number
      changedFiles: string[]
    }
  | {
      outcome: "merged"
      upstreamSha: string
      targetSha: string
      mergeSha: string
      behindBy: number
      aheadBy: number
      changedFiles: string[]
    }
  | {
      outcome: "conflict"
      upstreamSha: string
      targetSha: string
      behindBy: number
      aheadBy: number
      conflicts: string[]
    }

/**
 * Apply an upstream repository to a GitHub template-generated copy.
 *
 * GitHub's `merge-upstream` endpoint only works for forks. A repository made through the template
 * endpoint has an unrelated, single root commit, even though that root's tree is a byte-for-byte
 * copy of an upstream tree. The trusted worker therefore performs an explicit three-way tree merge:
 * the matching upstream tree is the base, the customer's branch is ours, and the current upstream
 * branch is theirs. The worker does not check out or execute repository files and disables hooks.
 * Pushing a changed Actions workflow can still cause GitHub to execute it; enabling updates means
 * trusting the recorded upstream in the same way GitHub's fork-sync operation does.
 *
 * The first run locates the base by matching the generated repository's root tree against upstream
 * history. Later runs use the upstream SHA already recorded in `upstream_sync_run`. A clean result
 * is committed with the customer's current HEAD as its sole parent, then pushed with an exact
 * force-with-lease. That makes a retry unable to overwrite a commit that arrived while it worked.
 */
export async function reconcileTemplateUpstream(
  input: TemplateUpstreamInput,
): Promise<TemplateUpstreamResult> {
  const directory = await mkdtemp(join(tmpdir(), "sproutos-template-upkeep-"))
  const controller = new AbortController()
  const abort = () => {
    controller.abort(input.signal?.reason)
  }
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted === true) abort()
  const deadline = setTimeout(() => {
    controller.abort(new Error("template upkeep timed out"))
  }, COMMAND_TIMEOUT_MS)
  deadline.unref()

  try {
    return await reconcileInDirectory({ ...input, signal: controller.signal }, directory)
  } finally {
    clearTimeout(deadline)
    input.signal?.removeEventListener("abort", abort)
    await rm(directory, { recursive: true, force: true })
  }
}

async function reconcileInDirectory(
  input: TemplateUpstreamInput,
  directory: string,
): Promise<TemplateUpstreamResult> {
  const targetUrl =
    input.targetUrl ?? `https://github.com/${encodeRepo(input.owner, input.repo)}.git`
  const [upstreamOwner, upstreamRepo, extra] = input.upstreamFullName.split("/")
  if (
    upstreamOwner === undefined ||
    upstreamRepo === undefined ||
    extra !== undefined ||
    upstreamOwner === "" ||
    upstreamRepo === ""
  ) {
    throw new Error(`upstream "${input.upstreamFullName}" is not owner/repo`)
  }
  const upstreamUrl =
    input.upstreamUrl ?? `https://github.com/${encodeRepo(upstreamOwner, upstreamRepo)}.git`

  const isolatedHome = join(directory, "home")
  await mkdir(isolatedHome)
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  }
  const targetEnv = { ...baseEnv, ...gitAuthEnv(targetUrl, input.token) }
  const git = async (
    args: string[],
    options: { env?: NodeJS.ProcessEnv; allowExit?: readonly number[] } = {},
  ) => {
    try {
      return await exec(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
        {
          cwd: directory,
          env: options.env ?? baseEnv,
          signal: input.signal,
          maxBuffer: MAX_OUTPUT_BYTES,
        },
      ).then((result) => ({ ...result, exitCode: 0 }))
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null
      if (typeof code === "number" && options.allowExit?.includes(code)) {
        return {
          stdout:
            typeof error === "object" && error !== null && "stdout" in error
              ? String(error.stdout)
              : "",
          stderr:
            typeof error === "object" && error !== null && "stderr" in error
              ? String(error.stderr)
              : "",
          exitCode: code,
        }
      }
      throw error
    }
  }

  {
    const version = (await git(["--version"])).stdout.trim()
    assertSupportedTemplateGit(version)
    await git(["init", "--quiet"])
    await git(["remote", "add", "target", targetUrl])
    await git(["remote", "add", "upstream", upstreamUrl])
    await git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "target",
        `+refs/heads/${input.branch}:refs/remotes/target/${input.branch}`,
      ],
      { env: targetEnv },
    )
    // The upstream recorded for a template is public catalogue provenance. Do not send the target
    // repository's installation token to a different host/repository.
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      "upstream",
      `+refs/heads/${input.upstreamBranch}:refs/remotes/upstream/${input.upstreamBranch}`,
    ])

    const targetRef = `refs/remotes/target/${input.branch}`
    const upstreamRef = `refs/remotes/upstream/${input.upstreamBranch}`
    const targetSha = (await git(["rev-parse", targetRef])).stdout.trim()
    const upstreamSha = (await git(["rev-parse", upstreamRef])).stdout.trim()
    if (input.expectedUpstreamSha !== undefined && upstreamSha !== input.expectedUpstreamSha) {
      throw new Error(
        "upstream changed during template reconciliation; the next run will compare again",
      )
    }
    const roots = lines((await git(["rev-list", "--max-parents=0", targetSha])).stdout)
    if (roots.length !== 1) {
      throw new Error(
        `template upkeep requires exactly one target root commit; found ${roots.length}`,
      )
    }

    const baseSha = input.baseUpstreamSha ?? (await findTemplateBase(git, roots, upstreamRef))

    // Ask for the merge base as data rather than relying on `--is-ancestor`'s silent exit code.
    const mergeBase = lines(
      (
        await git(["merge-base", baseSha, upstreamSha], {
          allowExit: [1],
        })
      ).stdout,
    )[0]
    if (mergeBase !== baseSha) {
      throw new Error(
        `recorded template upstream ${baseSha} is not an ancestor of ${input.upstreamFullName}@${input.upstreamBranch}`,
      )
    }

    const behindBy = Number(
      (await git(["rev-list", "--count", `${baseSha}..${upstreamSha}`])).stdout,
    )
    const targetRoot = roots[0]
    if (targetRoot === undefined) throw new Error("target repository has no root commit")
    const aheadBy = Number(
      (await git(["rev-list", "--count", `${targetRoot}..${targetSha}`])).stdout,
    )

    if (behindBy === 0) {
      return { outcome: "up_to_date", upstreamSha, targetSha, behindBy, aheadBy, changedFiles: [] }
    }

    const targetTree = (await git(["show", "-s", "--format=%T", targetSha])).stdout.trim()
    const targetDate = (await git(["show", "-s", "--format=%aI", targetSha])).stdout.trim()
    // Git 2.39 has the real ort-backed `merge-tree --write-tree`, but not 2.40's `--merge-base`
    // option. Give the target tree a temporary commit whose parent is the proven upstream base;
    // the ordinary two-head merge then discovers exactly that base without rewriting target history.
    const syntheticOurs = (
      await git(
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
          `Synthetic template merge base for ${targetSha}`,
        ],
        {
          env: {
            ...baseEnv,
            GIT_AUTHOR_DATE: targetDate,
            GIT_COMMITTER_DATE: targetDate,
          },
        },
      )
    ).stdout.trim()

    const merge = await git(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        syntheticOurs,
        upstreamSha,
      ],
      { allowExit: [1] },
    )
    const [tree = "", ...conflictEntries] = merge.stdout.split("\0").filter((part) => part !== "")
    const conflicts = [...new Set(conflictEntries)].sort()
    if (conflicts.length > 0) {
      return { outcome: "conflict", upstreamSha, targetSha, behindBy, aheadBy, conflicts }
    }
    if (merge.exitCode !== 0 || tree === "") {
      throw new Error("git could not produce a complete three-way merge tree")
    }

    const changedFiles = nulValues(
      (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", targetTree, tree]))
        .stdout,
    )
    if (tree === targetTree) {
      return { outcome: "up_to_date", upstreamSha, targetSha, behindBy, aheadBy, changedFiles: [] }
    }

    const upstreamDate = (await git(["show", "-s", "--format=%aI", upstreamSha])).stdout.trim()
    const mergeSha = (
      await git(
        [
          "-c",
          "user.name=SproutOS Upkeep",
          "-c",
          "user.email=upkeep@users.noreply.github.com",
          "commit-tree",
          tree,
          "-p",
          targetSha,
          "-m",
          `Apply ${input.upstreamFullName}@${upstreamSha.slice(0, 12)}`,
        ],
        {
          env: {
            ...baseEnv,
            GIT_AUTHOR_DATE: upstreamDate,
            GIT_COMMITTER_DATE: upstreamDate,
          },
        },
      )
    ).stdout.trim()

    const destination = input.updateBranch ?? input.branch
    await input.beforePush?.()
    const destinationSha = lines(
      (await git(["ls-remote", "target", `refs/heads/${destination}`], { env: targetEnv })).stdout,
    )[0]?.split("\t")[0]
    if (destinationSha !== mergeSha) {
      if (destination !== input.branch && destinationSha !== undefined) {
        throw new Error(
          `upkeep branch ${destination} changed after it was created; refusing to overwrite it`,
        )
      }
      await git(
        [
          "push",
          targetUrl,
          `${mergeSha}:refs/heads/${destination}`,
          ...(destination === input.branch
            ? [`--force-with-lease=refs/heads/${destination}:${targetSha}`]
            : [`--force-with-lease=refs/heads/${destination}:`]),
        ],
        { env: targetEnv },
      )
    }

    return {
      outcome: "merged",
      upstreamSha,
      targetSha,
      mergeSha,
      behindBy,
      aheadBy,
      changedFiles,
    }
  }
}

type Git = (
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; allowExit?: readonly number[] },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

async function findTemplateBase(git: Git, roots: readonly string[], upstreamRef: string) {
  const upstream = lines((await git(["log", "--format=%H%x09%T%x09%ct", upstreamRef])).stdout).map(
    (line) => {
      const [sha, tree, timestamp] = line.split("\t")
      return { sha, tree, timestamp: Number(timestamp) }
    },
  )

  for (const root of roots) {
    const rootTree = (await git(["show", "-s", "--format=%T", root])).stdout.trim()
    const rootTimestamp = Number((await git(["show", "-s", "--format=%ct", root])).stdout)
    const matches = upstream
      .filter((commit) => commit.sha !== undefined && commit.tree === rootTree)
      .sort((left, right) => {
        const leftAfter = left.timestamp > rootTimestamp ? 1 : 0
        const rightAfter = right.timestamp > rootTimestamp ? 1 : 0
        return leftAfter - rightAfter || right.timestamp - left.timestamp
      })
    const match = matches[0]?.sha
    if (match !== undefined) return match
  }

  throw new Error(
    "could not locate the template's original tree in upstream history; refusing a two-way overwrite",
  )
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

function nulValues(value: string): string[] {
  return value.split("\0").filter((entry) => entry !== "")
}

export function assertSupportedTemplateGit(output: string): void {
  const match = /git version (\d+)\.(\d+)/.exec(output)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    major < 2 ||
    (major === 2 && minor < 38)
  ) {
    throw new Error(
      `template upkeep requires Git 2.38 or newer for merge-tree --write-tree; found "${output}"`,
    )
  }
}

function encodeRepo(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

function gitAuthEnv(url: string, token: string): Record<string, string> {
  if (!url.startsWith("https://")) return {}
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  }
}
