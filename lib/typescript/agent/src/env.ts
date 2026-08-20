import type { ResolvedAgentCredential } from "./resolve"

/**
 * The environment the agent subprocess gets — built from nothing, not inherited.
 *
 * `Options.env` REPLACES the subprocess environment rather than merging with `process.env`, and
 * that is the property this module exists to use. The API process holds `DATABASE_URL`,
 * `STRIPE_SECRET_KEY`, `OPENAI_KEY`, the KMS configuration, and every other organization's
 * decrypted credentials as they pass through it. Inheriting that environment into a process whose
 * whole job is to run a model against a customer's repository would put all of it one `printenv`
 * away from whatever the model decides to do.
 *
 * So the allowlist is short and the credential is added by kind. Anything not named here does not
 * exist inside the agent.
 */
const INHERITED = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const

export class UnsupportedCredentialError extends Error {
  override readonly name = "UnsupportedCredentialError"

  constructor(readonly kind: string) {
    super(`${kind} cannot drive the Claude Code agent runner`)
  }
}

export function agentSubprocessEnv(
  credential: ResolvedAgentCredential,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }

  // Identifies us in the User-Agent, so Anthropic-side rate limiting and support can tell SproutOS
  // traffic from a person's own Claude Code.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "sproutos/1.0"
  // The runner is headless. Without this the CLI can try to open a browser on a login prompt.
  env.CI = "1"

  if (credential.billing !== "byo") {
    // Platform-billed runs go through the OpenAI path, not this one. Reaching here with anything
    // else would mean building an env with no credential in it and letting the subprocess fall
    // back to whatever happens to be configured on the host.
    throw new UnsupportedCredentialError(credential.billing)
  }

  switch (credential.kind) {
    case "claude_subscription":
      // The same variable the Claude Code CLI reads for a subscription login.
      env.CLAUDE_CODE_OAUTH_TOKEN = credential.secret
      break
    case "anthropic_api_key":
      env.ANTHROPIC_API_KEY = credential.secret
      break
    case "openai_api_key":
    case "openrouter_api_key":
      // Claude Code speaks to a third-party endpoint through the Anthropic-shaped variables, so
      // the endpoint has to be Anthropic-compatible. A bare OpenAI key is not, which is why
      // base_url is required for these kinds and validated before the run starts.
      if (credential.baseUrl === null) throw new UnsupportedCredentialError(credential.kind)
      env.ANTHROPIC_BASE_URL = credential.baseUrl
      env.ANTHROPIC_AUTH_TOKEN = credential.secret
      break
  }

  return { ...env, ...extra }
}

/**
 * Our `permission_mode` values are snake_case because they live in a CHECK constraint; the SDK's
 * are camelCase. Total by construction rather than a lookup with a default, so adding a mode to
 * the constraint without mapping it is a type error instead of a silent downgrade to `default` —
 * which, for a permission setting, would be a downgrade in the safe direction only by luck.
 */
export function toSdkPermissionMode(
  mode: string,
): "default" | "plan" | "acceptEdits" | "bypassPermissions" {
  switch (mode) {
    case "plan":
      return "plan"
    case "accept_edits":
      return "acceptEdits"
    case "bypass_permissions":
      return "bypassPermissions"
    default:
      return "default"
  }
}
