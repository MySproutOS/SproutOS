import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cloneUrl, gitAuthEnv, type Workspace } from "./workspace"

const run = promisify(execFile)

/**
 * Getting an agent's edits out of the checkout and into the repository.
 *
 * **The control plane commits; the agent does not.** `workspace.ts` states the rule and this is the
 * half that was missing — an agent could edit files in a temporary directory that was then deleted
 * in a `finally`, so its work had nowhere to go.
 *
 * Keeping the commit here rather than handing the model a push credential is not ceremony. `Bash`
 * is refused for this turn because the process holds the control-plane database URL, the envelope
 * KMS key and the GitHub App's own credentials; a token that can write to a customer's repository
 * is exactly the kind of thing that must not be reachable from a tool call in that process. The
 * platform stages the diff, so what gets pushed is something it can see and bound.
 */

export type CommitInput = {
  workspace: Workspace
  owner: string
  repo: string
  /** A GitHub App installation token with `contents: write`. Never reaches the agent. */
  token: string
  /** The branch to push to. Not the production branch unless the caller means it. */
  branch: string
  message: string
  host?: string
  /** Shown as the commit author. A bot identity, because a bot wrote it. */
  authorName?: string
  authorEmail?: string
}

export type CommitResult =
  | { committed: false; reason: "no_changes" }
  | { committed: true; sha: string; branch: string; files: string[] }

const DEFAULT_AUTHOR_NAME = "SproutOS Agent"
/**
 * `users.noreply.github.com` so the address is unroutable by construction.
 *
 * A real mailbox here would collect replies nobody reads, and inventing a plausible-looking address
 * on a domain we own is worse: it is a channel that appears to exist.
 */
const DEFAULT_AUTHOR_EMAIL = "agent@users.noreply.github.com"

/**
 * What the agent changed, as paths.
 *
 * `--porcelain` rather than `git diff --name-only`, because it has to include files the agent
 * *created* — which is most of what "make this repository deployable" produces — and an untracked
 * file is invisible to `diff` until it is staged.
 */
export async function changedFiles(workspace: Workspace): Promise<string[]> {
  const { stdout } = await run("git", ["-C", workspace.path, "status", "--porcelain"])
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== "")
}

/**
 * Stage everything, commit, and push the branch.
 *
 * Returns `no_changes` rather than throwing when the agent edited nothing. A turn that answered a
 * question without touching a file is the common case, not an error, and a caller that had to catch
 * an exception to discover it would eventually catch a real failure with it.
 */
export async function commitAndPush(input: CommitInput): Promise<CommitResult> {
  const { workspace, token, branch, message } = input
  const url = cloneUrl(input)

  const files = await changedFiles(workspace)
  if (files.length === 0) return { committed: false, reason: "no_changes" }

  await run("git", ["-C", workspace.path, "add", "-A"])

  /*
    Identity passed with `-c`, not written into the checkout's config.

    `git commit` refuses without a `user.email`, and the clone has none — there is no global git
    config in this container and there should not be one. Per-invocation flags keep the identity out
    of a directory the model can read, which is the same reasoning the clone credential follows.
  */
  await run("git", [
    "-C",
    workspace.path,
    "-c",
    `user.name=${input.authorName ?? DEFAULT_AUTHOR_NAME}`,
    "-c",
    `user.email=${input.authorEmail ?? DEFAULT_AUTHOR_EMAIL}`,
    "commit",
    "-m",
    message,
  ])

  const { stdout: sha } = await run("git", ["-C", workspace.path, "rev-parse", "HEAD"])

  /*
    `HEAD:refs/heads/<branch>`, so the local branch name is irrelevant.

    The clone is `--single-branch --depth 1` off the production branch, so its local branch is
    called whatever that was. Pushing `HEAD` to an explicit ref is what lets the agent's work land
    on a *different* branch without a checkout -b dance that would fail on a shallow clone.
  */
  await run(
    "git",
    ["-C", workspace.path, "push", url, `HEAD:refs/heads/${branch}`, "--force-with-lease"],
    { env: gitAuthEnv(url, token) },
  )

  return { committed: true, sha: sha.trim(), branch, files }
}
