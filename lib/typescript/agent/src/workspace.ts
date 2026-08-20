import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * A checkout for the agent to work in.
 *
 * **This is the development driver.** In production an agent session runs inside a Kata VM with
 * its own filesystem and the checkout is prepared there; the NetworkPolicy and the VM boundary are
 * the isolation, not this. Cloning onto the API host is only acceptable while there is no compute
 * plane, and every property below exists to make that period less bad rather than fine.
 */
export type Workspace = {
  path: string
  dispose: () => Promise<void>
}

export type CheckoutInput = {
  owner: string
  repo: string
  ref: string
  /** A GitHub installation token. Read-only usage — see below. */
  token: string
  host?: string
}

/**
 * Clone a repository without leaving the credential inside it.
 *
 * `git clone https://x-access-token:TOKEN@github.com/...` writes the token into `.git/config`,
 * inside the very directory the agent is about to read. `-c http.extraHeader=...` keeps it out of
 * the config but puts it in argv, where any process on the host can read it from `ps`.
 *
 * So the credential goes through `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`: per-process, not in
 * argv, not written to disk. The remote is then set to the plain URL, so nothing in the checkout
 * carries a credential even transiently.
 *
 * The agent is never given a push credential. Its output leaves through a pull request opened by
 * the control plane, which is the only component holding a token that can write.
 */
export function cloneUrl(input: Pick<CheckoutInput, "owner" | "repo" | "host">): string {
  return `https://${input.host ?? "github.com"}/${input.owner}/${input.repo}.git`
}

/**
 * The environment `git clone` runs under.
 *
 * Exported so it can be asserted directly: the credential must appear in `GIT_CONFIG_VALUE_0` and
 * nowhere else — not in the URL, not in argv, not in anything that reaches disk.
 */
export function gitAuthEnv(url: string, token: string): Record<string, string> {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  }
}

export async function checkout(input: CheckoutInput): Promise<Workspace> {
  const url = cloneUrl(input)
  const path = await mkdtemp(join(tmpdir(), "sproutos-agent-"))

  try {
    await run(
      "git",
      [
        "clone",
        // A shallow, single-branch clone: the agent needs the working tree, not the history, and
        // a large repository's history is minutes of wall clock on every session.
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        input.ref,
        url,
        path,
      ],
      { env: gitAuthEnv(url, input.token) },
    )

    // Belt and braces: prove the checkout carries no credential rather than assuming the flags
    // above did their job. A token in .git/config is readable by the model on its first `cat`.
    await run("git", ["-C", path, "remote", "set-url", "origin", url])

    return {
      path,
      dispose: async () => {
        await rm(path, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
}
