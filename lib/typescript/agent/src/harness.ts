import type { AgentCredentialKind } from "./resolve"

/**
 * Which coding agent runs a turn, decided by the credential it will run on.
 *
 * The two harnesses speak different wire formats, and that is the whole reason this function
 * exists rather than a single runner with a base URL:
 *
 * - **Claude Code** talks to Anthropic's Messages API. It reaches a third party only through
 *   `ANTHROPIC_BASE_URL`, so the third party has to *be* Anthropic-shaped.
 * - **Codex** talks to OpenAI's API, and its `model_providers` config makes any OpenAI-compatible
 *   endpoint — OpenRouter among them — a first-class provider rather than a shim.
 *
 * ## This corrects a path that could not work
 *
 * `env.ts` routes `openai_api_key` through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, with a
 * comment conceding that "a bare OpenAI key is not" Anthropic-compatible and requiring the customer
 * to supply an endpoint that is. There is no such endpoint at `api.openai.com`. So the dashboard
 * offered a credential kind whose only working configuration was one nobody would guess: an
 * Anthropic-compatible proxy the customer had to run themselves.
 *
 * Sending OpenAI keys to Codex removes the shim rather than documenting it.
 *
 * ## One day this may be neither
 *
 * Both harnesses are somebody else's CLI, which is fine while the product's value is the platform
 * around them and not the loop itself. If that changes — if the loop needs to know about
 * deployments, databases and hostnames in a way a general-purpose agent cannot be told — the honest
 * answer is our own harness, over something like OpenCode or a DeepSeek-hosted model.
 *
 * Deliberately not designed here. The reason to write it down is that this function is where that
 * decision would land: a third arm, not a rewrite, provided nothing outside it learns which harness
 * ran a turn.
 */
export const HARNESSES = ["claude-code", "codex"] as const
export type Harness = (typeof HARNESSES)[number]

/**
 * The provider entry Codex needs for a credential, matching its `model_providers` config.
 *
 * `wire_api` is `responses` for OpenRouter because that is what its OpenAI-compatible surface
 * implements; a provider that only speaks completions would need `chat` here, which is why this is
 * data rather than an assumption baked into the harness.
 */
export type CodexProvider = {
  name: string
  baseUrl: string
  /** The environment variable Codex reads the key from, per its `env_key` field. */
  envKey: string
  wireApi: "responses" | "chat"
}

export const OPENAI_PROVIDER: CodexProvider = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  envKey: "OPENAI_API_KEY",
  wireApi: "responses",
}

export const OPENROUTER_PROVIDER: CodexProvider = {
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  envKey: "OPENROUTER_API_KEY",
  wireApi: "responses",
}

/**
 * What the platform runs when a customer has configured nothing.
 *
 * Platform-billed, therefore capped — `agent_config.max_budget_micro_usd` exists for this and is
 * currently read by nothing. An uncapped fallback is an unbounded spend on our own key, started by
 * anyone who opens a chat.
 */
export const PLATFORM_FALLBACK_MODEL = "gpt-5.6-terra"

export function harnessFor(kind: AgentCredentialKind): Harness {
  switch (kind) {
    case "claude_subscription":
    case "anthropic_api_key":
      return "claude-code"
    case "openai_api_key":
    case "openrouter_api_key":
      return "codex"
  }
}

/**
 * The provider a Codex run uses, or `undefined` for a kind Codex does not serve.
 *
 * Returning `undefined` rather than throwing keeps this a pure lookup; the caller pairs it with
 * `harnessFor` and a kind that disagrees with its provider is a type error at the call site rather
 * than an exception at run time.
 */
export function codexProviderFor(kind: AgentCredentialKind): CodexProvider | undefined {
  switch (kind) {
    case "openai_api_key":
      return OPENAI_PROVIDER
    case "openrouter_api_key":
      return OPENROUTER_PROVIDER
    case "claude_subscription":
    case "anthropic_api_key":
      return undefined
  }
}

/**
 * Which provider wire format a credential kind means, for the LLM proxy.
 *
 * Total by construction rather than a lookup with a default: a kind added to the union without a
 * mapping is a type error here, not a session that silently sends an Anthropic key to OpenAI and
 * parses usage with the wrong shape — which would bill zero and look like a quiet turn.
 *
 * Lives beside `harnessFor` because the two answer halves of one question and were, briefly, in two
 * files that could disagree about the same credential.
 */
export function upstreamKindFor(
  kind: AgentCredentialKind,
): "anthropic" | "anthropic_oauth" | "openai" {
  switch (kind) {
    /*
      A subscription is an OAuth token, not an API key, and Anthropic wants it as a bearer with the
      `oauth-2025-04-20` opt-in. Sent as `x-api-key` — which is what "anthropic" means to the proxy
      — it is a 401 that reads like an invalid key, so every turn on a customer's own Claude
      subscription failed and the message pointed at their credential rather than at this line.

      The sandbox's CLI cannot supply the difference: it is configured with `ANTHROPIC_AUTH_TOKEN`
      and believes it is talking to an ordinary API-key endpoint. The proxy holds the credential, so
      the proxy is what knows.
    */
    case "claude_subscription":
      return "anthropic_oauth"
    case "anthropic_api_key":
      return "anthropic"
    case "openai_api_key":
    case "openrouter_api_key":
      return "openai"
  }
}
