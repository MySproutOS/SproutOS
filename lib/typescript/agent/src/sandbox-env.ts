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
  /** Reserved for a future harness wrapper; stock Claude Code and Codex do not consume it. */
  refreshUrl: string
  model?: string | null
  /**
   * The checkout, which is also where Codex's configuration lives.
   *
   * Passed in rather than imported, because the constant belongs to `sandbox-agent` and importing
   * it here would close a cycle. Defaulted to the same value it always has, so a caller cannot
   * silently point Codex at a directory the bootstrap never wrote.
   */
  workspace?: string
}): Record<string, string> {
  const env: Record<string, string> = {
    /*
      The refresh half is exposed for a future wrapper and for explicit token clients. The stock
      harnesses do not know this protocol; access tokens therefore outlive the bounded turn.
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
      /*
        Claude Code refuses `--dangerously-skip-permissions` when it is running as root, and a
        container's default user is root. `IS_SANDBOX` is the CLI's own escape hatch for the case
        where something else is the boundary — which is what a sandbox is.

        Set here rather than only where a driver happens to run as root: a snapshot that changes its
        user should not change whether the agent can edit anything, and the variable is harmless
        when it does not apply.
      */
      env.IS_SANDBOX = "1"
      break
    case "codex":
      /*
        Codex reads its provider from `config.toml` and the key from whatever `env_key` names.

        `codexOverrides` below passes that provider on the command line with `base_url` pointing
        here, so the variable name is ours to choose and is the same for every provider — the
        sandbox is not talking to OpenAI or OpenRouter, it is talking to us.
      */
      env.SPROUTOS_PROXY_KEY = input.token.accessToken
      /*
        Where Codex reads `config.toml` from — and it is not the working directory.

        Codex keeps its own state — session files, and the trust entry it writes for a directory
        it has been told to act in — under `$CODEX_HOME`, default `~/.codex`. Pointing it into the
        workspace keeps that beside the checkout, where `.git/info/exclude` already hides it, rather
        than in a home directory that a driver may or may not persist.
      */
      env.CODEX_HOME = `${input.workspace ?? "/workspace"}/.codex`
      break
  }

  return env
}

/**
 * How a Codex sandbox is told to talk to us: command-line overrides, not a file.
 *
 * It was a file — `$CODEX_HOME/config.toml` — until Codex was watched doing this to it:
 *
 *   [projects."/workspace"]
 *   trust_level = "trusted"
 *
 * Codex writes that file itself, and the write replaced everything in it, provider and all. The
 * next turn went to `wss://api.openai.com` with no key. A configuration file the tool being
 * configured also owns is not configuration; it is a suggestion.
 *
 * `-c` overrides are passed per invocation, so nothing can rewrite them between turns.
 *
 * The base URL is the proxy's **root**, with no `/v1`. Codex posts to `<base_url>/responses`, the
 * proxy forwards the path onto the session's upstream base — which for OpenAI already ends in
 * `/v1` — and the two halves compose to `/v1/responses`. Putting `/v1` on both ends produces
 * `/v1/v1/responses`, which is a 404 from the provider on every single turn.
 */
export function codexOverrides(input: { proxyBaseUrl: string; model: string }): string[] {
  const provider =
    `{name="sproutos",base_url="${input.proxyBaseUrl.replace(/\/+$/, "")}",` +
    `env_key="SPROUTOS_PROXY_KEY",wire_api="responses"}`

  return [
    "-c",
    `model_provider="sproutos"`,
    "-c",
    `model_providers.sproutos=${provider}`,
    "-c",
    `model="${input.model}"`,
    /*
      Codex prefers a WebSocket transport, built from the same base URL. The proxy speaks HTTP, so
      leaving this on costs five failed connections and about ten seconds of retries at the start of
      every turn before Codex falls back — visible to the customer as an agent that sits there.
    */
    "-c",
    "features.responses_websocket=false",
    /*
      Codex 0.150 enables remote compaction by default and consequently adds a
      `context_management` field to the first Responses request. The public OpenAI endpoint
      currently rejects that field for this provider/model combination with
      `400 context_management: Extra inputs are not permitted`, before the model can execute a
      single tool. SproutOS turns are bounded and start with a fresh CLI process, so client-side
      context replay is sufficient here; disable the optional remote-compaction transport until
      the upstream accepts it consistently.
    */
    "-c",
    "features.remote_compaction_v2=false",
  ]
}
