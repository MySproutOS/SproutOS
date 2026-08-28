import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  appJwt,
  createAppJwt,
  createGitHubClient,
  createInstallationTokenStore,
  createOrganizationRepository,
  createPersonalRepository,
  forkRepository,
  generateFromTemplate,
  type GitHubClient,
  GitHubCredentialError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  type GitHubRequest,
  githubAppConfigFromEnv,
  GitHubTransportError,
  GitHubValidationError,
  installationToken,
  listInstallationRepositories,
  MissingGitHubAppConfigError,
  userToken,
} from "./index"

type Handler = (request: GitHubRequest) => unknown

/**
 * The fake every provisioning test runs against.
 *
 * Nothing here touches the network: forking a repository for real would leave repositories behind
 * on somebody's account, and the credentials to do it are not present in a checkout anyway.
 */
function fakeClient(handlers: Record<string, Handler>): GitHubClient & { calls: GitHubRequest[] } {
  const calls: GitHubRequest[] = []

  return {
    calls,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
    async request<T>(request: GitHubRequest) {
      calls.push(request)
      const handler = handlers[`${request.method} ${request.path}`]
      if (handler === undefined) {
        throw new Error(`unexpected call: ${request.method} ${request.path}`)
      }

      return await Promise.resolve({
        status: 200,
        data: handler(request) as T,
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null },
      })
    },
  }
}

const REPO = {
  id: 41_234_567,
  node_id: "R_abc",
  name: "linkding",
  full_name: "acme/linkding",
  owner: { login: "acme", type: "Organization" },
  private: true,
  fork: true,
  default_branch: "main",
  html_url: "https://github.com/acme/linkding",
  clone_url: "https://github.com/acme/linkding.git",
  parent: {
    id: 100,
    full_name: "sissbruecker/linkding",
    default_branch: "master",
  },
}

describe("repository operations", () => {
  it("creates a personal repository with the user's OAuth token", async () => {
    const client = fakeClient({ "POST /user/repos": () => REPO })

    const repository = await createPersonalRepository(client, userToken("gho_x"), {
      name: "linkding",
      private: true,
    })

    expect(repository.id).toBe(41_234_567)
    expect(repository.fullName).toBe("acme/linkding")
    expect(repository.parent?.fullName).toBe("sissbruecker/linkding")
    expect(client.calls[0].credential.kind).toBe("user")
  })

  /**
   * ADR 0005: `POST /user/repos` is `enabledForGitHubApps: false`. The signature already refuses
   * this, so the cast is what a caller who deserialized a credential from JSON would have.
   */
  it("refuses an installation token for personal repository creation", async () => {
    const client = fakeClient({ "POST /user/repos": () => REPO })
    const installation = installationToken("ghs_x", 42, new Date(Date.now() + 3_600_000))

    await expect(
      createPersonalRepository(client, installation as unknown as ReturnType<typeof userToken>, {
        name: "linkding",
      }),
    ).rejects.toThrow(GitHubCredentialError)

    expect(client.calls).toHaveLength(0)
  })

  it("creates an organization repository with either credential kind", async () => {
    const client = fakeClient({ "POST /orgs/acme/repos": () => REPO })
    const installation = installationToken("ghs_x", 42, new Date(Date.now() + 3_600_000))

    const repository = await createOrganizationRepository(client, installation, "acme", {
      name: "linkding",
    })

    expect(repository.ownerType).toBe("Organization")
    expect(client.calls[0].credential.kind).toBe("installation")
  })

  it("forks the default branch only by default", async () => {
    const client = fakeClient({ "POST /repos/sissbruecker/linkding/forks": () => REPO })

    await forkRepository(client, userToken("gho_x"), {
      owner: "sissbruecker",
      repo: "linkding",
      organization: "acme",
    })

    expect(client.calls[0].body).toMatchObject({
      organization: "acme",
      default_branch_only: true,
    })
  })

  it("generates from a template", async () => {
    const client = fakeClient({
      "POST /repos/sproutos/starter/generate": () => ({ ...REPO, fork: false, parent: undefined }),
    })

    const repository = await generateFromTemplate(client, userToken("gho_x"), {
      templateOwner: "sproutos",
      templateRepo: "starter",
      name: "linkding",
      owner: "acme",
    })

    expect(repository.fork).toBe(false)
    expect(repository.parent).toBeNull()
  })

  it("lists the repositories an installation can reach", async () => {
    const client = fakeClient({
      "GET /installation/repositories": () => ({ total_count: 1, repositories: [REPO] }),
    })

    const page = await listInstallationRepositories(
      client,
      installationToken("ghs_x", 42, new Date(Date.now() + 3_600_000)),
    )

    expect(page.totalCount).toBe(1)
    expect(page.repositories[0].fullName).toBe("acme/linkding")
    expect(client.calls[0].query).toStrictEqual({ page: 1, per_page: 100 })
  })
})

describe("app authentication", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" })

  it("signs an RS256 JWT whose window GitHub will accept", () => {
    const now = new Date("2026-08-20T12:00:00Z")
    const token = createAppJwt({ appId: "4657519", privateKeyPem }, now)

    const [header, payload, signature] = token.split(".")
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toStrictEqual({
      alg: "RS256",
      typ: "JWT",
    })

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iat: number
      exp: number
      iss: string
    }
    const issuedSeconds = Math.floor(now.getTime() / 1000)
    expect(claims.iss).toBe("4657519")
    expect(claims.iat).toBe(issuedSeconds - 60)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(signature.length).toBeGreaterThan(0)
  })

  /**
   * `GITHUB_APP_PRIVATE_KEY` is empty in a fresh checkout. The failure has to name the variable,
   * because the alternative is an OpenSSL decoder error ten frames down inside `createSign`.
   */
  it("names the missing variable rather than crashing inside the signer", () => {
    expect(() =>
      githubAppConfigFromEnv({ GITHUB_APP_ID: "4657519", GITHUB_APP_PRIVATE_KEY: "" }),
    ).toThrow(MissingGitHubAppConfigError)

    expect(() =>
      githubAppConfigFromEnv({ GITHUB_APP_ID: "4657519", GITHUB_APP_PRIVATE_KEY: "" }),
    ).toThrow(/GITHUB_APP_PRIVATE_KEY/)

    expect(() => githubAppConfigFromEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem })).toThrow(
      /GITHUB_APP_ID/,
    )
  })

  it("un-escapes a PEM that was flattened into a single .env line", () => {
    const config = githubAppConfigFromEnv({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem.replaceAll("\n", "\\n"),
    })

    expect(config.privateKeyPem).toBe(privateKeyPem)
    expect(() => createAppJwt(config)).not.toThrow()
  })

  it("caches an installation token and re-mints it before it expires", async () => {
    let clock = new Date("2026-08-20T12:00:00Z")
    let minted = 0

    const client = fakeClient({
      "POST /app/installations/42/access_tokens": () => {
        minted += 1
        return {
          token: `ghs_${minted}`,
          expires_at: new Date(clock.getTime() + 3_600_000).toISOString(),
        }
      },
    })

    const store = createInstallationTokenStore({
      client,
      signJwt: () => "header.payload.signature",
      now: () => clock,
    })

    const scope = { purpose: "agent-clone", repositoryId: REPO.id } as const
    const first = await store.get(42, scope)
    const second = await store.get(42, scope)
    expect(first.token).toBe("ghs_1")
    expect(second.token).toBe("ghs_1")
    expect(minted).toBe(1)
    expect(client.calls[0].credential).toStrictEqual(appJwt("header.payload.signature"))
    expect(client.calls[0].body).toStrictEqual({
      repository_ids: [REPO.id],
      permissions: { contents: "read" },
    })

    // Fifty-six minutes in, the token has four minutes left — inside the five-minute skew, so it
    // is refused rather than handed to a fork that would outlive it.
    clock = new Date(clock.getTime() + 56 * 60_000)
    const third = await store.get(42, scope)
    expect(third.token).toBe("ghs_2")
    expect(minted).toBe(2)
  })

  it("keeps separate cache entries per installation", async () => {
    const client = fakeClient({
      "POST /app/installations/1/access_tokens": () => ({
        token: "ghs_one",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      "POST /app/installations/2/access_tokens": () => ({
        token: "ghs_two",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })

    const store = createInstallationTokenStore({ client, signJwt: () => "j.w.t" })

    const scope = { purpose: "project-repository-read", repositoryId: REPO.id } as const
    expect((await store.get(1, scope)).token).toBe("ghs_one")
    expect((await store.get(2, scope)).token).toBe("ghs_two")

    store.clear(1)
    await store.get(1, scope)
    expect(client.calls).toHaveLength(3)
  })

  it("never reuses a token across repositories or purposes, or gives Daytona administration", async () => {
    let minted = 0
    const client = fakeClient({
      "POST /app/installations/42/access_tokens": () => ({
        token: `ghs_${++minted}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
    const store = createInstallationTokenStore({ client, signJwt: () => "j.w.t" })

    const readOne = await store.get(42, { purpose: "sandbox-clone", repositoryId: 101 })
    const readTwo = await store.get(42, { purpose: "sandbox-clone", repositoryId: 202 })
    const writeOne = await store.get(42, { purpose: "sandbox-push", repositoryId: 101 })
    const agentWriteOne = await store.get(42, { purpose: "agent-push", repositoryId: 101 })

    expect([readOne.token, readTwo.token, writeOne.token, agentWriteOne.token]).toStrictEqual([
      "ghs_1",
      "ghs_2",
      "ghs_3",
      "ghs_4",
    ])
    expect(client.calls.map((call) => call.body)).toStrictEqual([
      { repository_ids: [101], permissions: { contents: "read" } },
      { repository_ids: [202], permissions: { contents: "read" } },
      {
        repository_ids: [101],
        permissions: { contents: "write", workflows: "write" },
      },
      {
        repository_ids: [101],
        permissions: { contents: "write", workflows: "write" },
      },
    ])
  })

  it("keeps broad read-only discovery separate from trusted repository provisioning", async () => {
    let minted = 0
    const client = fakeClient({
      "POST /app/installations/42/access_tokens": () => ({
        token: `ghs_${++minted}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
    const store = createInstallationTokenStore({ client, signJwt: () => "j.w.t" })

    await store.get(42, { purpose: "repository-picker" })
    await store.get(42, { purpose: "repository-provision" })

    expect(client.calls.map((call) => call.body)).toStrictEqual([
      { permissions: { metadata: "read" } },
      { permissions: { administration: "write", contents: "read" } },
    ])
  })

  it("mints and caches a read-only token scoped to Deployment-Templates", async () => {
    let minted = 0
    const client = fakeClient({
      "POST /app/installations/42/access_tokens": () => ({
        token: `ghs_catalogue_${++minted}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    })
    const store = createInstallationTokenStore({ client, signJwt: () => "j.w.t" })

    const first = await store.get(42, { purpose: "catalogue-attestation-read" })
    const second = await store.get(42, { purpose: "catalogue-attestation-read" })

    expect(first.token).toBe("ghs_catalogue_1")
    expect(second.token).toBe("ghs_catalogue_1")
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].body).toStrictEqual({
      repositories: ["Deployment-Templates"],
      permissions: { contents: "read", metadata: "read" },
    })
  })

  it("rejects invalid repository identifiers before signing or calling GitHub", async () => {
    const client = fakeClient({})
    const signJwt = vi.fn<() => string>(() => "j.w.t")
    const store = createInstallationTokenStore({ client, signJwt })

    await expect(
      store.get(42, { purpose: "sandbox-clone", repositoryId: Number.NaN }),
    ).rejects.toThrow(/positive safe integer/)
    await expect(store.get(42, { purpose: "sandbox-clone", repositoryId: -1 })).rejects.toThrow(
      /positive safe integer/,
    )
    expect(signJwt).not.toHaveBeenCalled()
    expect(client.calls).toHaveLength(0)
  })
})

describe("error mapping", () => {
  function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    return createGitHubClient({
      fetch: async () =>
        await Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { ...headers } }),
        ),
    })
  }

  it("surfaces a primary rate limit as a typed error with a wait", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 120
    const client = respond(
      403,
      { message: "API rate limit exceeded for user ID 1." },
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": String(resetAt),
      },
    )

    const error = await client
      .request({ method: "GET", path: "/user/repos", credential: userToken("gho_x") })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    const limited = error as GitHubRateLimitError
    expect(limited.secondary).toBe(false)
    expect(limited.retryAfterSeconds).toBeGreaterThan(100)
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(120)
  })

  it("prefers retry-after and marks a secondary rate limit", async () => {
    const client = respond(
      403,
      { message: "You have exceeded a secondary rate limit." },
      { "retry-after": "37" },
    )

    const error = await client
      .request({ method: "POST", path: "/user/repos", credential: userToken("gho_x") })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBe(37)
    expect((error as GitHubRateLimitError).secondary).toBe(true)
  })

  it("never lets a raw fetch failure escape", async () => {
    const client = createGitHubClient({
      fetch: async () => await Promise.reject(new TypeError("fetch failed")),
    })

    await expect(
      client.request({ method: "GET", path: "/user", credential: userToken("gho_x") }),
    ).rejects.toThrow(GitHubTransportError)
  })

  it("distinguishes not-found from a refused name", async () => {
    await expect(
      respond(404, { message: "Not Found" }).request({
        method: "GET",
        path: "/repos/acme/nope",
        credential: userToken("gho_x"),
      }),
    ).rejects.toThrow(GitHubNotFoundError)

    await expect(
      respond(422, {
        message: "Repository creation failed.",
        documentation_url: "https://docs",
      }).request({ method: "POST", path: "/user/repos", credential: userToken("gho_x") }),
    ).rejects.toThrow(GitHubValidationError)
  })

  it("reads the rate-limit headers off a successful response", async () => {
    const client = respond(
      200,
      { id: 1, full_name: "acme/x" },
      { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4998" },
    )

    const response = await client.request({
      method: "GET",
      path: "/repos/acme/x",
      credential: userToken("gho_x"),
    })

    expect(response.rateLimit.remaining).toBe(4998)
    expect(response.rateLimit.limit).toBe(5000)
  })
})
