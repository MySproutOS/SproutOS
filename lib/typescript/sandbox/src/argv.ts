/**
 * Turn an argument vector into one shell word-for-word safe command line.
 *
 * The provider's API takes a command *string* and runs it through a shell. Our API takes `argv`,
 * because that is the shape a caller cannot be tricked into by coercion — see
 * `apps/internal-api/src/utils/require-array.ts`, written after TypeBox's `Value.Convert` turned
 * `"ls -la"` into `["ls -la"]` and the route answered 200 for a request nobody had made.
 *
 * Somewhere between those two the vector has to become a string, and how it becomes one is the
 * whole security property. `argv.join(" ")` looks like the answer and is not:
 *
 * ```
 * exec(["git", "commit", "-m", "fix; rm -rf ~"])   →   git commit -m fix; rm -rf ~
 * ```
 *
 * The shell sees two commands. The customer's agent asked for one. Every metacharacter has this
 * shape — `;`, `&&`, `|`, `` ` ``, `$(…)`, a newline — so an escape list is a list somebody will
 * finish incompletely.
 *
 * Single quotes are the whole answer instead, because inside them POSIX shells expand nothing at
 * all: not `$`, not backticks, not backslashes. The only character that cannot appear is `'`
 * itself, which is closed, escaped and reopened. That is a rule with no exceptions to enumerate,
 * which is why it is used here rather than a denylist.
 */

/** Characters that need no quoting at all. Deliberately conservative: quoting extra costs nothing. */
const SAFE = /^[A-Za-z0-9._\-/=:@,+]+$/

/**
 * Quote one argument so a POSIX shell reads it as exactly these bytes.
 *
 * The empty string quotes to `''` rather than to nothing, or it would vanish from the vector and
 * shift every argument after it by one.
 */
export function quoteArg(arg: string): string {
  if (arg === "") return "''"
  if (SAFE.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * Join an argument vector into a command line.
 *
 * Rejects an empty vector rather than returning an empty string: an empty command run through a
 * shell succeeds silently, and a caller who reached here with nothing to run has a bug that should
 * surface as one.
 *
 * A NUL byte cannot survive `execve` and cannot be quoted into a shell word, so it is refused here
 * rather than truncating the argument somewhere further down where it would look like a typo.
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new Error("Cannot run an empty command")
  }
  for (const arg of argv) {
    if (arg.includes("\0")) {
      throw new Error("Command arguments cannot contain a NUL byte")
    }
  }
  return argv.map(quoteArg).join(" ")
}
