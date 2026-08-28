import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEPLOYMENT_CATALOGUE_ARTIFACT_TYPE,
  deploymentCatalogueInternals,
  pullDeploymentCatalogue,
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

afterEach(() => vi.unstubAllGlobals())

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
