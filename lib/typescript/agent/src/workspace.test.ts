import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { cloneUrl, gitAuthEnv } from "./workspace"

const run = promisify(execFile)

/**
 * The property under test is where the *credential* ends up, which is a question about the git
 * invocation rather than about GitHub. So the credential half is asserted directly and the clone
 * half runs against a repository created here — hermetic, and it still exercises the real `git`.
 */
describe("gitAuthEnv", () => {
  const url = "https://github.com/octocat/Hello-World.git"
  const token = "ghs_fixtureTokenThatMustNotLeak"

  it("puts the credential in the environment and nowhere else", () => {
    const env = gitAuthEnv(url, token)

    // Base64 of `x-access-token:<token>`. Present exactly once, in the value git reads per
    // process — never in argv, where `ps` would show it to anything running on the host.
    expect(env.GIT_CONFIG_VALUE_0).toContain(
      Buffer.from(`x-access-token:${token}`).toString("base64"),
    )
    const elsewhere = Object.entries(env).filter(
      ([key, value]) => key !== "GIT_CONFIG_VALUE_0" && value.includes(token),
    )
    expect(elsewhere).toEqual([])
  })

  it("never puts the credential in the URL", () => {
    // `https://x-access-token:TOKEN@github.com/...` is the obvious way to do this and the reason
    // this function exists: git writes that URL straight into .git/config, inside the directory
    // the agent is about to read.
    const built = cloneUrl({ owner: "octocat", repo: "Hello-World" })
    expect(built).toBe(url)
    expect(built).not.toContain("x-access-token")
    expect(built).not.toContain(token)
  })

  it("refuses to prompt, so a bad credential fails instead of hanging", () => {
    // A clone that blocks on "Username for 'https://github.com':" holds a runner slot forever.
    expect(gitAuthEnv(url, token).GIT_TERMINAL_PROMPT).toBe("0")
  })

  it("does not inherit the API process's environment", () => {
    process.env.DATABASE_URL = "postgres://real"
    try {
      expect(gitAuthEnv(url, token).DATABASE_URL).toBeUndefined()
    } finally {
      delete process.env.DATABASE_URL
    }
  })
})

const workspaces: string[] = []

afterAll(async () => {
  const { rm } = await import("node:fs/promises")
  for (const path of workspaces) await rm(path, { recursive: true, force: true })
})

describe("what a clone leaves on disk", () => {
  it("carries no credential material in .git/config", async () => {
    // A real repository, made here, cloned by real git. No network and no GitHub.
    const origin = await mkdtemp(join(tmpdir(), "sproutos-origin-"))
    const clone = await mkdtemp(join(tmpdir(), "sproutos-clone-"))
    workspaces.push(origin, clone)

    await run("git", ["init", "--initial-branch", "main", origin])
    await writeFile(join(origin, "README.md"), "# fixture\n")
    await run("git", ["-C", origin, "add", "."])
    await run("git", [
      "-C",
      origin,
      "-c",
      "user.email=fixture@test.invalid",
      "-c",
      "user.name=Fixture",
      "commit",
      "-m",
      "initial",
    ])

    const token = "ghs_fixtureTokenThatMustNotLeak"
    const publicUrl = cloneUrl({ owner: "octocat", repo: "Hello-World" })

    await run(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--branch", "main", origin, clone],
      {
        env: gitAuthEnv(publicUrl, token),
      },
    )
    // The same rewrite the checkout does, proving the config ends up credential-free rather than
    // assuming the clone flags managed it.
    await run("git", ["-C", clone, "remote", "set-url", "origin", publicUrl])

    const config = await readFile(join(clone, ".git", "config"), "utf8")
    expect(config).not.toContain(token)
    expect(config).not.toContain("x-access-token")
    expect(config).not.toContain("extraHeader")
    expect(config).toContain(publicUrl)
  }, 60_000)
})
