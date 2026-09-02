import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000

export type RepositorySnapshotInput = {
  owner: string
  repo: string
  branch: string
  upstreamFullName: string
  upstreamBranch: string
  /** Exact signed-template commit. When present, branch movement must not affect the snapshot. */
  upstreamCommit?: string
  token: string
  signal?: AbortSignal
  targetUrl?: string
  upstreamUrl?: string
}

/** Seed an empty repository with one root commit containing an upstream branch's current tree. */
export async function copyRepositorySnapshot(input: RepositorySnapshotInput): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sproutos-repository-snapshot-"))
  const isolatedHome = join(directory, "home")
  await mkdir(isolatedHome)
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
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  }
  const git = async (args: string[], env: NodeJS.ProcessEnv = baseEnv) =>
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args], {
      cwd: directory,
      env,
      signal: input.signal,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })

  try {
    await git(["init", "--quiet"])
    await git(["remote", "add", "upstream", upstreamUrl])
    let upstreamSha: string
    if (input.upstreamCommit === undefined) {
      await git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "upstream",
        `+refs/heads/${input.upstreamBranch}:refs/remotes/upstream/source`,
      ])
      upstreamSha = (await git(["rev-parse", "refs/remotes/upstream/source"])).stdout.trim()
    } else {
      if (!/^[0-9a-f]{40}$/.test(input.upstreamCommit)) {
        throw new Error("upstream commit must be a lowercase 40-character Git commit")
      }
      await git(["fetch", "--quiet", "--depth=1", "--no-tags", "upstream", input.upstreamCommit])
      upstreamSha = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim()
      if (upstreamSha !== input.upstreamCommit) {
        throw new Error("fetched upstream commit does not match the signed template commit")
      }
    }
    const tree = (await git(["show", "-s", "--format=%T", upstreamSha])).stdout.trim()
    const timestamp = (await git(["show", "-s", "--format=%aI", upstreamSha])).stdout.trim()
    const root = (
      await git(
        ["commit-tree", tree, "-m", `Initial snapshot of ${input.upstreamFullName}@${upstreamSha}`],
        {
          ...baseEnv,
          GIT_AUTHOR_NAME: "SproutOS",
          GIT_AUTHOR_EMAIL: "upkeep@users.noreply.github.com",
          GIT_COMMITTER_NAME: "SproutOS",
          GIT_COMMITTER_EMAIL: "upkeep@users.noreply.github.com",
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_DATE: timestamp,
        },
      )
    ).stdout.trim()

    await git(["remote", "add", "target", targetUrl])
    const targetEnv = { ...baseEnv, ...gitAuthEnv(targetUrl, input.token) }
    try {
      await git(
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "target",
          `refs/heads/${input.branch}:refs/remotes/target/current`,
        ],
        targetEnv,
      )
      const existingTree = (
        await git(["show", "-s", "--format=%T", "refs/remotes/target/current"])
      ).stdout.trim()
      if (existingTree !== tree) {
        throw new Error("snapshot destination is no longer empty and does not match the upstream")
      }
      return (await git(["rev-parse", "refs/remotes/target/current"])).stdout.trim()
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
      if (!/couldn't find remote ref/u.test(stderr)) throw error
    }

    await git(
      ["push", "--quiet", "--force-with-lease", "target", `${root}:refs/heads/${input.branch}`],
      targetEnv,
    )
    return root
  } finally {
    await rm(directory, { recursive: true, force: true })
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
