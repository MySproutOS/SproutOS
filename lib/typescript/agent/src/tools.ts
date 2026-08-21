/**
 * Which tools an agent turn may use while it runs in the control plane.
 *
 * ADR 0012 puts agent sessions in a `kata-clh` sandbox: a VM boundary, and a NetworkPolicy that
 * blocks the API server, every other tenant, and link-local. That is not wired yet, so a turn runs
 * in the `internal-api` pod — and that pod holds the control-plane database URL, the envelope KMS
 * key, the GitHub App credentials, AWS access keys, and a projected Kubernetes service-account
 * token.
 *
 * `agentSubprocessEnv` already replaces the subprocess's environment wholesale, which keeps those
 * values out of `process.env`. It is necessary and it is not sufficient: the subprocess runs as the
 * same uid as the API, so `/proc/1/environ` hands back the parent's environment in full, and the
 * service-account token is a file on disk that any read can reach.
 *
 * So `Bash` is refused. Not because command execution is unsafe in principle — it is the point of
 * the product — but because *this* is the wrong process to execute it in, and the difference is a
 * VM that does not exist yet.
 */

/**
 * Tools withheld until the sandbox exists.
 *
 * Spelled out one per line with its reason, rather than derived from a category, so that removing
 * one has to be done deliberately and next to the sentence explaining what it costs.
 */
export const CONTROL_PLANE_DISALLOWED_TOOLS = [
  // Arbitrary commands as the API's own uid. `cat /proc/1/environ` is the whole exploit.
  "Bash",
  "BashOutput",
  "KillShell",
  // Fetches a URL the model chose, from inside the VPC. The same reasoning that keeps
  // `action.http` out of the job worker — see `@lib/workflows`'s NODE_RUNTIME.
  "WebFetch",
  // Runs a subagent, which would inherit this same process and this same reasoning, minus the
  // list.
  "Task",
] as const

/**
 * What is left, and why it is safe here.
 *
 * The file tools operate on the checkout the runner made under a temporary directory and passed as
 * `cwd`. They are the tools "say in a sentence what you want changed" actually needs: read the
 * project, edit the project, write the project.
 */
export const CONTROL_PLANE_ALLOWED_NOTE =
  "Read, Write, Edit, Glob, Grep, TodoWrite — the workspace tools"

/** The SDK spelling. A copy so callers do not spread a readonly tuple into an SDK option. */
export function disallowedTools(): string[] {
  return [...CONTROL_PLANE_DISALLOWED_TOOLS]
}
