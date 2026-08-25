import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { quoteArg, quoteArgv } from "./argv"

const run = promisify(execFile)

/**
 * Against a real shell, because the claim is about what a shell does.
 *
 * A test asserting that `quoteArg("a'b")` equals a particular string asserts that this file agrees
 * with itself. The property that matters is that `sh -c` splits the result back into exactly the
 * words we started with, and the only thing that knows how `sh -c` splits words is `sh`.
 *
 * `printf '%s\\0' …` reuses its format for every remaining argument, so the output is the vector
 * observed from the far side. The separator is NUL rather than a newline because an argument may
 * legitimately *contain* a newline, and then a newline-separated reading cannot tell a word that
 * spans two lines from two words — the harness would report a quoting bug that is its own. NUL is
 * available as a separator precisely because {@link quoteArgv} refuses it inside an argument.
 */
async function roundTrip(args: string[]): Promise<string[]> {
  const command = quoteArgv(["printf", "%s\\0", ...args])
  const { stdout } = await run("/bin/sh", ["-c", command])
  return stdout.split("\0").slice(0, -1)
}

describe("quoteArgv", () => {
  it("leaves ordinary arguments alone", () => {
    expect(quoteArgv(["git", "status"])).toBe("git status")
    expect(quoteArg("--depth=1")).toBe("--depth=1")
    expect(quoteArg("/home/daytona/repo")).toBe("/home/daytona/repo")
  })

  it("quotes the empty string rather than dropping it", async () => {
    expect(quoteArg("")).toBe("''")
    await expect(roundTrip(["a", "", "b"])).resolves.toEqual(["a", "", "b"])
  })

  it("refuses an empty vector", () => {
    expect(() => quoteArgv([])).toThrow(/empty command/)
  })

  it("refuses a NUL byte", () => {
    expect(() => quoteArgv(["echo", "a\0b"])).toThrow(/NUL/)
  })

  /*
    The cases that motivate the file. Each of these, naively joined, is a second command.
  */
  it.each([
    ["semicolon", "fix; rm -rf ~"],
    ["ampersands", "a && b"],
    ["pipe", "a | tee /etc/passwd"],
    ["subshell", "$(whoami)"],
    ["backticks", "`whoami`"],
    ["variable", "$HOME"],
    ["backslash", "a\\b"],
    ["single quote", "it's"],
    ["nested quoting", `'; echo pwned; '`],
    ["double quote", 'say "hi"'],
    ["newline", "line one\nline two"],
    ["glob", "*"],
    ["tilde", "~"],
    ["redirect", "> /tmp/owned"],
  ])("survives %s intact", async (_name, arg) => {
    await expect(roundTrip([arg])).resolves.toEqual([arg])
  })

  it("keeps a dangerous argument as one word rather than running it", async () => {
    // If the quoting failed, `whoami` would run and its output would appear instead.
    const out = await roundTrip(["git", "commit", "-m", "$(whoami); rm -rf ~"])
    expect(out).toEqual(["git", "commit", "-m", "$(whoami); rm -rf ~"])
  })

  it("preserves argument count under adversarial spacing", async () => {
    const args = ["  leading", "trailing  ", "a b c", "\t"]
    await expect(roundTrip(args)).resolves.toEqual(args)
  })
})
