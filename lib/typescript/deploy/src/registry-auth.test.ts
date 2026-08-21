import { describe, expect, it } from "vitest"
import {
  dockerConfig,
  mintRegistryCredential,
  registryKind,
  UnsupportedRegistryError,
} from "./registry-auth"

/**
 * The credential the build pushes with — the one that did not exist.
 *
 * `deploy/builds/namespace.yaml` described it in its opening paragraph and no Secret was ever
 * created, so every build compiled the application, exported an image, and failed asking Artifact
 * Registry for an anonymous token. These assert the two things that were wrong in that failure:
 * that a credential is produced at all, and that it is produced in the form the registry expects.
 */

const ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com"
const AR = "us-central1-docker.pkg.dev"
/** What `BUILD_REGISTRY` actually holds: Artifact Registry addresses carry a repository path. */
const AR_FULL = "us-central1-docker.pkg.dev/project-e6c082ea/sproutos"

describe("registryKind", () => {
  it("tells the two clouds apart from the hostname", () => {
    // From the host, not from a configuration flag. A deployment whose `BUILD_REGISTRY` and cloud
    // flag disagree has one mistake; making the flag authoritative turns it into an hour spent on
    // a 403 that mentions neither.
    expect(registryKind(ECR)).toBe("ecr")
    expect(registryKind(AR)).toBe("artifact-registry")
    expect(registryKind("gcr.io")).toBe("artifact-registry")
    expect(registryKind("registry.example.com")).toBe("unknown")
    /*
      With the repository path, which is what `BUILD_REGISTRY` is set to.

      Artifact Registry addresses are `host/project/repository` and the deployment configures the
      whole prefix, because that is what an image reference needs. Matching the full string against
      a host pattern made the live worker report that `us-central1-docker.pkg.dev/…/sproutos` "is
      not a registry this can mint a credential for". ECR has no path component, so a test written
      only against an ECR-shaped value could not have caught it.
    */
    expect(registryKind(AR_FULL)).toBe("artifact-registry")
    // Not ECR: the suffix has to end the host, or `…amazonaws.com.evil.test` would match.
    expect(registryKind(`${ECR}.evil.test`)).toBe("unknown")
  })
})

describe("dockerConfig", () => {
  it("writes both the pair and the encoded form", () => {
    // Clients disagree about which they read, and a config carrying only one authenticates against
    // some registries and not others.
    const config = dockerConfig(AR, "oauth2accesstoken", "ya29.token")

    expect(config.auths[AR]).toEqual({
      username: "oauth2accesstoken",
      password: "ya29.token",
      auth: Buffer.from("oauth2accesstoken:ya29.token").toString("base64"),
    })
  })

  it("keys the entry on the host, not the repository path", () => {
    // Some clients match the path-qualified key and some do not, and the one that does not falls
    // back to anonymous — the failure this module exists to remove.
    expect(Object.keys(dockerConfig(ECR, "AWS", "p").auths)).toEqual([ECR])
    expect(Object.keys(dockerConfig(AR_FULL, "oauth2accesstoken", "t").auths)).toEqual([AR])
  })
})

describe("mintRegistryCredential", () => {
  it("uses the metadata server for Artifact Registry, with the username Google requires", async () => {
    const seen: { url: string; flavor: string | null }[] = []
    const credential = await mintRegistryCredential(AR, {
      fetchImpl: ((url: string, init?: RequestInit) => {
        seen.push({
          url: String(url),
          flavor: new Headers(init?.headers).get("Metadata-Flavor"),
        })
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "ya29.abc", expires_in: 3599 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }) as typeof fetch,
    })

    expect(credential.username).toBe("oauth2accesstoken")
    expect(credential.password).toBe("ya29.abc")
    expect(credential.expiresAt.getTime()).toBeGreaterThan(Date.now())
    // Without the header the metadata server refuses, and the refusal is a 403 that reads like an
    // IAM problem rather than a missing header.
    expect(seen[0]?.flavor).toBe("Google")
    expect(seen[0]?.url).toContain("metadata.google.internal")
  })

  it("says what to fix when the metadata server refuses", async () => {
    await expect(
      mintRegistryCredential(AR, {
        fetchImpl: () => Promise.resolve(new Response("", { status: 403 })),
      }),
    ).rejects.toThrow(/Workload Identity/)
  })

  it("splits ECR's single base64 field into a user and a password", async () => {
    // ECR returns `AWS:<password>` base64-encoded in one field, and the password itself contains
    // no colon — but splitting on the *first* one is what keeps that true if it ever does.
    const expiresAt = new Date("2026-08-22T00:00:00.000Z")
    const credential = await mintRegistryCredential(ECR, {
      ecr: {
        send: () =>
          Promise.resolve({
            authorizationData: [
              {
                authorizationToken: Buffer.from("AWS:pa:ss:word").toString("base64"),
                expiresAt,
              },
            ],
          }),
      },
    })

    expect(credential).toEqual({ username: "AWS", password: "pa:ss:word", expiresAt })
  })

  it("refuses a registry it cannot mint for, by name", async () => {
    await expect(mintRegistryCredential("registry.example.com")).rejects.toBeInstanceOf(
      UnsupportedRegistryError,
    )
  })
})
