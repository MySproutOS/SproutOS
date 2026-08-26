import { describe, expect, it } from "vitest"
import type { AgentCredentialKind } from "./resolve"
import {
  codexProviderFor,
  harnessFor,
  OPENAI_PROVIDER,
  OPENROUTER_PROVIDER,
  PLATFORM_FALLBACK_MODEL,
} from "./harness"

const ALL_KINDS: AgentCredentialKind[] = [
  "claude_subscription",
  "anthropic_api_key",
  "openai_api_key",
  "openrouter_api_key",
]

describe("harnessFor", () => {
  it("runs Anthropic credentials on Claude Code", () => {
    expect(harnessFor("claude_subscription")).toBe("claude-code")
    expect(harnessFor("anthropic_api_key")).toBe("claude-code")
  })

  /*
    The correction.

    `env.ts` sends an OpenAI key through `ANTHROPIC_BASE_URL`, which only works against an
    Anthropic-shaped endpoint — and `api.openai.com` is not one. The kind was offered in the
    dashboard and had no working configuration a customer would find.
  */
  it("runs OpenAI-shaped credentials on Codex", () => {
    expect(harnessFor("openai_api_key")).toBe("codex")
    expect(harnessFor("openrouter_api_key")).toBe("codex")
  })

  /*
    Total over the CHECK constraint's values.

    A kind added to `agent_credential_kind_check` without a case here is a TypeScript error rather
    than a run-time fall-through to whichever harness happens to be first — which, for a credential,
    would mean sending a customer's key to the wrong provider.
  */
  it("has an answer for every kind the database allows", () => {
    expect(ALL_KINDS.map(harnessFor)).toEqual(["claude-code", "claude-code", "codex", "codex"])
  })
})

describe("codexProviderFor", () => {
  it("gives OpenRouter the responses wire API", () => {
    // OpenRouter's OpenAI-compatible surface implements `responses`; a provider speaking only
    // completions would need `chat`, which is why this is data rather than a constant in the runner.
    expect(codexProviderFor("openrouter_api_key")).toEqual(OPENROUTER_PROVIDER)
    expect(OPENROUTER_PROVIDER.wireApi).toBe("responses")
    expect(OPENROUTER_PROVIDER.envKey).toBe("OPENROUTER_API_KEY")
  })

  it("points OpenAI at its own endpoint rather than an Anthropic shim", () => {
    expect(codexProviderFor("openai_api_key")).toEqual(OPENAI_PROVIDER)
    expect(OPENAI_PROVIDER.baseUrl).toBe("https://api.openai.com/v1")
  })

  it("has no provider for a kind Codex does not serve", () => {
    expect(codexProviderFor("claude_subscription")).toBeUndefined()
    expect(codexProviderFor("anthropic_api_key")).toBeUndefined()
  })

  /*
    Every Codex kind must have a provider, or the run has nowhere to send a request.

    Asserted as one comparison over the whole set rather than an `expect` inside an `if` — a
    conditional assertion passes when the condition never holds, which for a loop over an empty or
    mis-filtered list means a test that checks nothing and reports success.
  */
  it("gives every Codex kind a provider", () => {
    const codexKinds = ALL_KINDS.filter((kind) => harnessFor(kind) === "codex")
    expect(codexKinds).toEqual(["openai_api_key", "openrouter_api_key"])
    expect(codexKinds.map((kind) => codexProviderFor(kind)?.name)).toEqual(["openai", "openrouter"])
  })
})

describe("the platform fallback", () => {
  it("names the model rather than leaving the provider to choose", () => {
    // A wrong slug should be a provider error naming the model, not a silent substitution.
    expect(PLATFORM_FALLBACK_MODEL).toBe("gpt-5.6-terra")
  })
})
