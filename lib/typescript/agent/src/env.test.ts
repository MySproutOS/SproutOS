import { afterEach, describe, expect, it } from "vitest"
import { agentSubprocessEnv, toSdkPermissionMode, UnsupportedCredentialError } from "./env"
import type { AgentCredentialKind, ResolvedAgentCredential } from "./resolve"

/**
 * The agent subprocess runs a model against a customer's repository. The process that spawns it
 * holds every other customer's decrypted credentials, the database URL, and the Stripe key. These
 * tests are the boundary between those two facts.
 */
function byo(
  kind: AgentCredentialKind,
  overrides: Partial<Extract<ResolvedAgentCredential, { billing: "byo" }>> = {},
): ResolvedAgentCredential {
  return {
    billing: "byo",
    credentialId: "01a01e00-0000-7000-8000-000000000001",
    kind,
    secret: "the-secret-value",
    baseUrl: null,
    model: null,
    permissionMode: "default",
    maxBudgetMicroUsd: null,
    ...overrides,
  }
}

const POLLUTANTS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "OPENAI_KEY",
  "KMS_KEY_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "AWS_SECRET_ACCESS_KEY",
]

afterEach(() => {
  for (const name of POLLUTANTS) delete process.env[name]
})

describe("agentSubprocessEnv", () => {
  it("does not inherit the API process's secrets", () => {
    for (const name of POLLUTANTS) process.env[name] = `real-${name}`

    const env = agentSubprocessEnv(byo("anthropic_api_key"))

    // `Options.env` replaces the subprocess environment rather than merging, and this is the
    // whole reason the runner passes it. A leak here is every tenant's secrets one `printenv`
    // away from whatever the model decides to run.
    for (const name of POLLUTANTS) expect(env[name]).toBeUndefined()
  })

  it("carries only the handful of variables a process needs to run at all", () => {
    process.env.DATABASE_URL = "postgres://real"
    process.env.SOME_UNRELATED_THING = "leaked"
    try {
      const env = agentSubprocessEnv(byo("anthropic_api_key"))

      // An allowlist, asserted as one. Anything new that appears here is a deliberate decision
      // someone has to make rather than something that arrived by inheritance.
      const permitted = new Set([
        "PATH",
        "HOME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TZ",
        "TMPDIR",
        "CLAUDE_AGENT_SDK_CLIENT_APP",
        "CI",
        "ANTHROPIC_API_KEY",
      ])
      const unexpected = Object.keys(env).filter((name) => !permitted.has(name))
      expect(unexpected).toEqual([])
      expect(env.SOME_UNRELATED_THING).toBeUndefined()
    } finally {
      delete process.env.SOME_UNRELATED_THING
    }
  })

  it("uses the variable each credential kind is actually read from", () => {
    expect(agentSubprocessEnv(byo("anthropic_api_key")).ANTHROPIC_API_KEY).toBe("the-secret-value")

    // A subscription is an OAuth token, not an API key. Putting it in ANTHROPIC_API_KEY would
    // fail authentication in a way that reads as "your subscription is invalid".
    const subscription = agentSubprocessEnv(byo("claude_subscription"))
    expect(subscription.CLAUDE_CODE_OAUTH_TOKEN).toBe("the-secret-value")
    expect(subscription.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("refuses a third-party key with no endpoint to send it to", () => {
    // Claude Code reaches a third party through the Anthropic-shaped variables, so the endpoint
    // has to speak that protocol. A bare OpenAI key does not, and starting the run anyway would
    // send the customer's key to api.anthropic.com.
    expect(() => agentSubprocessEnv(byo("openai_api_key"))).toThrow(UnsupportedCredentialError)

    const routed = agentSubprocessEnv(
      byo("openrouter_api_key", { baseUrl: "https://openrouter.ai/api/v1" }),
    )
    expect(routed.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1")
    expect(routed.ANTHROPIC_AUTH_TOKEN).toBe("the-secret-value")
  })

  it("refuses to build an environment for a platform-billed run", () => {
    // Our OpenAI key is not an Anthropic-shaped endpoint. Building an env without a credential
    // would let the subprocess fall back to whatever is configured on the host — which, on a
    // shared runner, is somebody else's login.
    expect(() =>
      agentSubprocessEnv({
        billing: "platform",
        provider: "openai",
        model: null,
        permissionMode: "default",
        maxBudgetMicroUsd: null,
      }),
    ).toThrow(UnsupportedCredentialError)
  })
})

describe("toSdkPermissionMode", () => {
  it("translates every mode the CHECK constraint allows", () => {
    expect(toSdkPermissionMode("default")).toBe("default")
    expect(toSdkPermissionMode("plan")).toBe("plan")
    expect(toSdkPermissionMode("accept_edits")).toBe("acceptEdits")
    expect(toSdkPermissionMode("bypass_permissions")).toBe("bypassPermissions")
  })

  it("falls back to the most restrictive mode for anything it does not know", () => {
    // The database stores snake_case; the SDK wants camelCase. An unmapped value must not become
    // a permissive mode by accident.
    expect(toSdkPermissionMode("acceptEdits")).toBe("default")
    expect(toSdkPermissionMode("")).toBe("default")
  })
})
