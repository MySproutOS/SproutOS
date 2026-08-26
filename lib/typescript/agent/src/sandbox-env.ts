import type { Harness } from "./harness"
import type { MintedProxyToken } from "./proxy-token"

/**
 * The environment a sandbox agent runs with.
 *
 * Distinct from `agentSubprocessEnv`, and the difference is the whole point of the proxy. That one
 * builds an environment for a process **we** run, on our own machine, and hands it the customer's
 * real credential. This one builds an environment for a process running on a machine a model can
 * execute arbitrary commands on — so the credential in it must be worthless to anyone who takes it.
 *
 * What goes in is a proxy token and a base URL pointing at our own listener. What never goes in is
 * a model provider's key. `CreateSandboxInput.env` has said so since it was written; this is the
 * function that makes it true.
 */

/**
 * The variables each harness reads for "where is the API and what may I use".
 *
 * Both harnesses take an OpenAI- or Anthropic-shaped base URL and a token, which is exactly why the
 * proxy can sit in front of either without the agent knowing it is there.
 */
export function sandboxAgentEnv(input: {
  harness: Harness
  /** Where the router's LLM proxy answers, from inside the sandbox. */
  proxyBaseUrl: string
  token: MintedProxyToken
  /** Where the agent exchanges its refresh token, so a long turn does not die at 15 minutes. */
  refreshUrl: string
  model?: string | null
}): Record<string, string> {
  const env: Record<string, string> = {
    /*
      The refresh half, so the agent can keep itself alive.

      Without these a turn stops at the access token's expiry — fifteen minutes — which is shorter
      than plenty of legitimate work. The agent is expected to exchange the refresh token when a
      call comes back 401; the token is useless to anyone who cannot also reach our API.
    */
    SPROUTOS_AGENT_REFRESH_TOKEN: input.token.refreshToken,
    SPROUTOS_AGENT_REFRESH_URL: input.refreshUrl,
    SPROUTOS_AGENT_TOKEN_EXPIRES_AT: input.token.accessExpiresAt.toISOString(),
  }

  if (input.model != null && input.model !== "") {
    env.SPROUTOS_AGENT_MODEL = input.model
  }

  switch (input.harness) {
    case "claude-code":
      /*
        Claude Code reads an Anthropic-shaped base URL and an auth token.

        `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`: the key variable is for a real Anthropic
        credential and some tooling validates its shape. This is a bearer for our proxy, which is
        what the auth-token variable is for.
      */
      env.ANTHROPIC_BASE_URL = input.proxyBaseUrl
      env.ANTHROPIC_AUTH_TOKEN = input.token.accessToken
      break
    case "codex":
      /*
        Codex reads its provider from `config.toml` and the key from whatever `env_key` names.

        `codexConfig` below writes that file with `base_url` pointing here, so the variable name is
        ours to choose and is the same for every provider — the sandbox is not talking to OpenAI or
        OpenRouter, it is talking to us.
      */
      env.SPROUTOS_PROXY_KEY = input.token.accessToken
      break
  }

  return env
}

/**
 * The `config.toml` a Codex sandbox runs with.
 *
 * Written rather than templated from the customer's provider, because from the sandbox's point of
 * view there is only one provider: ours. The real provider is chosen at token-mint time and lives
 * on the token row, which is what lets a customer switch from OpenAI to OpenRouter without anything
 * inside the sandbox changing.
 *
 * `wire_api = "responses"` because that is what both our upstreams' OpenAI-compatible surfaces
 * implement, and what the proxy's usage parser expects to see `response.completed` on.
 */
export function codexConfig(input: { proxyBaseUrl: string; model: string }): string {
  return `# Written by SproutOS. The endpoint below is SproutOS's proxy, not a model provider:
# the sandbox never holds a provider credential.
[model_providers.sproutos]
name = "sproutos"
base_url = "${input.proxyBaseUrl}"
env_key = "SPROUTOS_PROXY_KEY"

[settings]
model_provider = "sproutos"
model = "${input.model}"
wire_api = "responses"
`
}
