import { afterEach, describe, expect, it, vi } from "vitest"
import type { GitHubClient, GitHubRequest } from "@lib/github"
import {
  DEPLOYMENT_CATALOGUE_ARTIFACT_TYPE,
  deploymentCatalogueInternals,
  discoverCurrentDeploymentCatalogue,
  pullDeploymentCatalogue,
  verifyDeploymentCatalogueProvenance,
} from "./deployment-catalogue-oci"

function response(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(bytes).toString("utf8"), {
    status: 200,
    headers: { "content-length": String(bytes.byteLength), ...headers },
  })
}

function fixture() {
  const layers = new Map([
    ["catalogue.json", Buffer.from("catalogue\n")],
    ["provenance.json", Buffer.from("provenance\n")],
    ["plugin-lock.json", Buffer.from("lock\n")],
  ])
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      artifactType: DEPLOYMENT_CATALOGUE_ARTIFACT_TYPE,
      layers: [...layers].map(([title, bytes]) => ({
        mediaType: "application/json",
        digest: deploymentCatalogueInternals.sha256(bytes),
        size: bytes.byteLength,
        annotations: { "org.opencontainers.image.title": title },
      })),
    }),
  )
  return { layers, manifest, digest: deploymentCatalogueInternals.sha256(manifest) }
}

function releaseFixture() {
  const sourceSha = "a".repeat(40)
  const ociDigest = `sha256:${"b".repeat(64)}`
  const tag = `catalogue-${sourceSha}`
  const subjects = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sourceCommit: sourceSha,
      subjects: [
        {
          kind: "catalogue",
          id: "catalogue",
          name: "ghcr.io/mysproutos/deployment-catalogue",
          tag: `sha-${sourceSha}`,
          digest: ociDigest,
          layout: "oci/catalogue",
        },
      ],
    }),
  )
  const subjectsUrl = `https://github.com/MySproutOS/Deployment-Templates/releases/download/${tag}/subjects.json`
  const release = Buffer.from(
    JSON.stringify([
      {
        tag_name: `isolation-proofs-${sourceSha}`,
        target_commitish: sourceSha,
        draft: false,
        prerelease: false,
        immutable: true,
        published_at: "2099-01-02T00:00:01Z",
        assets: [],
      },
      {
        tag_name: `catalogue-${"c".repeat(40)}`,
        target_commitish: "c".repeat(40),
        draft: false,
        prerelease: false,
        immutable: true,
        published_at: "2099-01-01T00:00:00Z",
        assets: [],
      },
      {
        tag_name: tag,
        target_commitish: sourceSha,
        draft: false,
        prerelease: false,
        immutable: true,
        published_at: "2099-01-02T00:00:00Z",
        assets: [
          {
            name: "subjects.json",
            state: "uploaded",
            content_type: "application/json",
            browser_download_url: subjectsUrl,
            digest: deploymentCatalogueInternals.sha256(subjects),
            size: subjects.byteLength,
          },
        ],
      },
    ]),
  )
  return { ociDigest, release, sourceSha, subjects, subjectsUrl }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CATALOGUE_TEST_ENV
})

describe("deployment catalogue OCI pull", () => {
  it("accepts only descriptor-hashed bytes from the exact three named layers", async () => {
    const data = fixture()
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/manifests/")) {
        return Promise.resolve(response(data.manifest, { "docker-content-digest": data.digest }))
      }
      const digest = url.slice(url.lastIndexOf("/") + 1)
      const entry = [...data.layers].find(
        ([, bytes]) => deploymentCatalogueInternals.sha256(bytes) === digest,
      )
      if (entry === undefined) return Promise.resolve(new Response(null, { status: 404 }))
      return Promise.resolve(response(entry[1]))
    })

    const pulled = await pullDeploymentCatalogue(data.digest)
    expect(Buffer.from(pulled.catalogue).toString()).toBe("catalogue\n")
    expect(Buffer.from(pulled.provenance).toString()).toBe("provenance\n")
    expect(Buffer.from(pulled.pluginLock).toString()).toBe("lock\n")
  })

  it("refuses a registry response whose bytes disagree with the descriptor", async () => {
    const data = fixture()
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/manifests/")) {
        return Promise.resolve(response(data.manifest, { "docker-content-digest": data.digest }))
      }
      return Promise.resolve(response(Buffer.from("tampered")))
    })

    await expect(pullDeploymentCatalogue(data.digest)).rejects.toThrow(/descriptor/)
  })

  it("refuses another artifact type before reading any layer", async () => {
    const manifest = Buffer.from(
      JSON.stringify({ schemaVersion: 2, artifactType: "application/vnd.attacker", layers: [] }),
    )
    const digest = deploymentCatalogueInternals.sha256(manifest)
    vi.stubGlobal("fetch", () =>
      Promise.resolve(response(manifest, { "docker-content-digest": digest })),
    )
    await expect(pullDeploymentCatalogue(digest)).rejects.toThrow(/not a SproutOS/)
  })
})

describe("deployment catalogue release discovery", () => {
  it("discovers the exact digest and source commit from an immutable trusted release", async () => {
    const data = releaseFixture()
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(response(url === data.subjectsUrl ? data.subjects : data.release)),
    )

    await expect(discoverCurrentDeploymentCatalogue()).resolves.toEqual({
      ociDigest: data.ociDigest,
      sourceSha: data.sourceSha,
    })
  })

  it("refuses mutable releases and release assets whose bytes do not match GitHub's digest", async () => {
    const mutable = releaseFixture()
    const mutableRelease = JSON.parse(mutable.release.toString("utf8")) as Array<
      Record<string, unknown>
    >
    mutableRelease[2].immutable = false
    vi.stubGlobal("fetch", () =>
      Promise.resolve(response(Buffer.from(JSON.stringify(mutableRelease)))),
    )
    await expect(discoverCurrentDeploymentCatalogue()).rejects.toThrow(/final immutable release/)

    const changed = releaseFixture()
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(response(url === changed.subjectsUrl ? Buffer.from("{}") : changed.release)),
    )
    await expect(discoverCurrentDeploymentCatalogue()).rejects.toThrow(/immutable release asset/)
  })

  it("refuses a subject that points outside the trusted catalogue repository", async () => {
    const data = releaseFixture()
    const subjects = JSON.parse(data.subjects.toString("utf8")) as {
      subjects: Array<{ name: string }>
    }
    subjects.subjects[0].name = "ghcr.io/attacker/deployment-catalogue"
    const changedSubjects = Buffer.from(JSON.stringify(subjects))
    const release = JSON.parse(data.release.toString("utf8")) as Array<{
      assets: Array<{ digest: string; size: number }>
    }>
    release[2].assets[0].digest = deploymentCatalogueInternals.sha256(changedSubjects)
    release[2].assets[0].size = changedSubjects.byteLength
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        response(url === data.subjectsUrl ? changedSubjects : Buffer.from(JSON.stringify(release))),
      ),
    )

    await expect(discoverCurrentDeploymentCatalogue()).rejects.toThrow(/trusted catalogue artifact/)
  })

  it("uses GitHub CLI's exact-workflow policy without mutually exclusive identity flags", () => {
    const reference = `ghcr.io/mysproutos/deployment-catalogue@sha256:${"b".repeat(64)}`
    const sourceSha = "a".repeat(40)
    const args = deploymentCatalogueInternals.githubAttestationVerifyArguments(reference, sourceSha)

    expect(args).toContain("--signer-workflow")
    expect(args).not.toContain("--cert-identity")
    expect(args.slice(args.indexOf("--source-ref"), args.indexOf("--source-ref") + 2)).toEqual([
      "--source-ref",
      "refs/heads/main",
    ])
    expect(
      args.slice(args.indexOf("--source-digest"), args.indexOf("--source-digest") + 2),
    ).toEqual(["--source-digest", sourceSha])
    expect(args).toContain("--deny-self-hosted-runners")
  })
})

describe("deployment catalogue provenance authentication", () => {
  const ociDigest = `sha256:${"b".repeat(64)}`
  const sourceSha = "a".repeat(40)
  type TestExec = (
    command: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>

  it("injects the installation token only into gh while preserving the worker environment", async () => {
    const calls: Array<{
      command: string
      options: { env?: NodeJS.ProcessEnv }
    }> = []
    const exec = vi.fn<TestExec>(
      async (
        command: string,
        _args: readonly string[],
        options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
      ) => {
        calls.push({ command, options })
        return await Promise.resolve({
          stdout: command === "gh" ? '[{"verified":true}]' : "",
          stderr: "",
        })
      },
    )
    process.env.CATALOGUE_TEST_ENV = "preserved"

    await expect(
      verifyDeploymentCatalogueProvenance(ociDigest, sourceSha, {
        exec,
        githubToken: async () => await Promise.resolve("ghs_catalogue_secret"),
      }),
    ).resolves.toHaveLength(1)

    expect(calls.map((call) => call.command)).toStrictEqual(["cosign", "gh"])
    expect(calls[0].options.env).toBeUndefined()
    expect(calls[1].options.env).toMatchObject({
      CATALOGUE_TEST_ENV: "preserved",
      GH_TOKEN: "ghs_catalogue_secret",
    })
  })

  it("redacts a token even when gh echoes it in its failure", async () => {
    const token = "ghs_must_never_escape"
    const exec = vi.fn<TestExec>(async (command: string) => {
      if (command === "gh") throw new Error(`authentication failed for ${token}`)
      return await Promise.resolve({ stdout: "", stderr: "" })
    })

    const error = await verifyDeploymentCatalogueProvenance(ociDigest, sourceSha, {
      exec,
      githubToken: async () => await Promise.resolve(token),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(token)
    expect((error as Error).message).toContain("[REDACTED]")
  })

  it("fails closed without invoking gh when installation-token minting fails", async () => {
    const exec = vi.fn<TestExec>(
      async (_command: string) => await Promise.resolve({ stdout: "", stderr: "" }),
    )

    await expect(
      verifyDeploymentCatalogueProvenance(ociDigest, sourceSha, {
        exec,
        githubToken: () =>
          Promise.reject(new Error("Deployment-Templates installation unavailable")),
      }),
    ).rejects.toThrow(/installation unavailable/)

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0][0]).toBe("cosign")
  })

  it("discovers the repository installation and reuses its narrow cached token", async () => {
    const calls: GitHubRequest[] = []
    let minted = 0
    const client: GitHubClient = {
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
      async request<T>(request: GitHubRequest) {
        calls.push(request)
        const data =
          request.method === "GET"
            ? { id: 91_002 }
            : {
                token: `ghs_catalogue_${++minted}`,
                expires_at: "2099-01-01T00:00:00Z",
              }
        return await Promise.resolve({
          status: 200,
          data: data as T,
          rateLimit: { limit: 5000, remaining: 4999, resetAt: null },
        })
      },
    }
    const provider = deploymentCatalogueInternals.createCatalogueGitHubTokenProvider(
      client,
      () => "app.jwt.signature",
    )

    await expect(provider()).resolves.toBe("ghs_catalogue_1")
    await expect(provider()).resolves.toBe("ghs_catalogue_1")

    expect(calls.map((call) => `${call.method} ${call.path}`)).toStrictEqual([
      "GET /repos/MySproutOS/Deployment-Templates/installation",
      "POST /app/installations/91002/access_tokens",
      "GET /repos/MySproutOS/Deployment-Templates/installation",
    ])
    expect(calls[0].credential).toMatchObject({ kind: "app", token: "app.jwt.signature" })
    expect(calls[1].body).toStrictEqual({
      repositories: ["Deployment-Templates"],
      permissions: { contents: "read", metadata: "read" },
    })
  })
})
