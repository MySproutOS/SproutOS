import { describe, expect, it } from "vitest"

import { codexConfig, sandboxAgentEnv } from "./sandbox-env"

const token = {
  accessExpiresAt: new Date("2026-01-01T00:15:00Z"),
  accessToken: "spa_access",
  id: "01a03e5d-8cbf-7415-9ac6-82c3476aeb5c",
  refreshExpiresAt: new Date("2026-01-01T12:00:00Z"),
  refreshToken: "spr_refresh",
}

const base = {
  proxyBaseUrl: "https://llm.sproutos.me",
  refreshUrl: "https://api.sproutos.me/v1/orgs/acme/agent/proxy-token/refresh",
  token,
}

describe("sandboxAgentEnv", () => {
  it("never puts a provider credential in the sandbox", () => {
    // The property the whole proxy exists for. A sandbox is a machine a model runs arbitrary
    // commands on; a provider key here is one `printenv` from exfiltration, bills the customer
    // directly, and cannot be rotated by us.
    for (const harness of ["claude-code", "codex"] as const) {
      const env = sandboxAgentEnv({ ...base, harness })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.OPENROUTER_API_KEY).toBeUndefined()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()

      // Everything that *is* a secret in here is a proxy token, which is worthless without our
      // listener and revocable in one UPDATE.
      const values = Object.values(env)
      expect(values).toContain(token.accessToken)
      expect(values.some((value) => value.startsWith("sk-"))).toBe(false)
    }
  })

  it("points Claude Code at the proxy, not at Anthropic", () => {
    const env = sandboxAgentEnv({ ...base, harness: "claude-code" })
    expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.sproutos.me")
    // The auth-token variable rather than the api-key one: the key variable is for a real Anthropic
    // credential and some tooling validates its shape.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("spa_access")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("gives Codex the key under our own name", () => {
    const env = sandboxAgentEnv({ ...base, harness: "codex" })
    expect(env.SPROUTOS_PROXY_KEY).toBe("spa_access")
    // Codex reads its base URL from config.toml, so no base-url variable is set for it — and
    // setting OPENAI_BASE_URL would point a stray tool at the wrong place.
    expect(env.OPENAI_BASE_URL).toBeUndefined()
  })

  it("carries the refresh half, so a long turn does not die at fifteen minutes", () => {
    const env = sandboxAgentEnv({ ...base, harness: "claude-code" })
    expect(env.SPROUTOS_AGENT_REFRESH_TOKEN).toBe("spr_refresh")
    expect(env.SPROUTOS_AGENT_REFRESH_URL).toContain("/proxy-token/refresh")
    // The agent needs to know when to bother: without the expiry it either refreshes on every call
    // or discovers the problem as a 401 halfway through a tool use.
    expect(env.SPROUTOS_AGENT_TOKEN_EXPIRES_AT).toBe("2026-01-01T00:15:00.000Z")
  })

  it("omits the model rather than setting it empty", () => {
    // An empty `SPROUTOS_AGENT_MODEL` is not "use the default" to anything that reads it — it is a
    // model named "", which is a provider error naming a model nobody chose.
    expect(
      sandboxAgentEnv({ ...base, harness: "codex", model: "" }).SPROUTOS_AGENT_MODEL,
    ).toBeUndefined()
    expect(
      sandboxAgentEnv({ ...base, harness: "codex", model: null }).SPROUTOS_AGENT_MODEL,
    ).toBeUndefined()
    expect(
      sandboxAgentEnv({ ...base, harness: "codex", model: "gpt-5.6-terra" }).SPROUTOS_AGENT_MODEL,
    ).toBe("gpt-5.6-terra")
  })
})

describe("codexConfig", () => {
  it("names one provider, which is ours", () => {
    const config = codexConfig({ model: "gpt-5.6-terra", proxyBaseUrl: "https://llm.sproutos.me" })
    // From the sandbox's point of view there is only one provider. Which real one is behind it is
    // decided at token-mint time, which is what lets a customer switch from OpenAI to OpenRouter
    // without anything inside the sandbox changing.
    expect(config).toContain('base_url = "https://llm.sproutos.me"')
    expect(config).toContain('env_key = "SPROUTOS_PROXY_KEY"')
    expect(config).toContain('model_provider = "sproutos"')
    expect(config).not.toContain("api.openai.com")
    expect(config).not.toContain("openrouter.ai")
  })

  it("asks for the responses wire API, which is what the proxy parses", () => {
    // The usage parser looks for `response.completed`. A provider configured for the completions
    // API would stream a shape it never counts, and the turn would bill zero.
    expect(codexConfig({ model: "m", proxyBaseUrl: "u" })).toContain('wire_api = "responses"')
  })
})

describe("what the harness needs to be able to act at all", () => {
  it("tells Claude Code that something else is the boundary", () => {
    // The CLI refuses `--dangerously-skip-permissions` as root, and a container's default user is
    // root. Without this every edit is denied and the turn still reports success — which is how the
    // first sandbox turn ever run announced a file it had not written.
    expect(sandboxAgentEnv({ ...base, harness: "claude-code" }).IS_SANDBOX).toBe("1")
  })

  it("points Codex at the config the bootstrap actually wrote", () => {
    // Codex reads `$CODEX_HOME/config.toml`, never the working directory. The file naming our proxy
    // is written into the checkout, so without this Codex would look in `~/.codex`, find nothing,
    // and try to reach OpenAI directly with no key.
    expect(sandboxAgentEnv({ ...base, harness: "codex" }).CODEX_HOME).toBe("/workspace/.codex")
    expect(
      sandboxAgentEnv({ ...base, harness: "codex", workspace: "/home/daytona/workspace" })
        .CODEX_HOME,
    ).toBe("/home/daytona/workspace/.codex")
  })
})
