import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import {
  isTrustedDeploymentCatalogueWorkflow,
  reconcileSignedDeploymentCatalogue,
} from "./deployment-catalogue"
import type { DeploymentCatalogueArtifact } from "./deployment-catalogue-oci"
import {
  deploymentCatalogueSchemaInternals,
  parseCatalogueAppManifest,
} from "./deployment-catalogue-schema"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const SOURCE_SHA = "a".repeat(40)
const PLUGIN_DIGEST = `sha256:${"1".repeat(64)}`
const FIRST_OCI_DIGEST = `sha256:${"2".repeat(64)}`
const SECOND_OCI_DIGEST = `sha256:${"3".repeat(64)}`
const REFUSED_OCI_DIGEST = `sha256:${"4".repeat(64)}`
const APP_ID = "catalogue-import-test-app"

function bytes(value: unknown): Uint8Array {
  return Buffer.from(`${deploymentCatalogueSchemaInternals.canonical(value)}\n`)
}

function app() {
  return {
    schema_version: 1,
    id: APP_ID,
    name: "Catalogue import test",
    pitch: "A signed catalogue fixture that remains hidden while its capability is blocked.",
    description_md: "Not a public listing.",
    homepage: null,
    repository: {
      url: "https://github.com/MySproutOS/catalogue-import-test",
      commit: "b".repeat(40),
    },
    license: "MIT",
    platform: "web",
    readiness: {
      status: "blocked",
      blocked_reasons: ["The end-to-end deployment has not passed."],
      e2e_evidence: null,
    },
    plugin: {
      repository: "ghcr.io/mysproutos/catalogue-import-test-plugin",
      digest: PLUGIN_DIGEST,
      protocol_version: 1,
    },
    deployment: {
      preset: "web",
      runtime: "provided.al2023",
      architecture: "arm64",
      migration: null,
      required_capabilities: ["generic_web"],
    },
    services: [
      {
        key: "postgres",
        kind: "postgres",
        bindings: [{ environment: "DATABASE_URL", output: "connection_url" }],
      },
    ],
    user_inputs: [],
    generated_inputs: [],
  }
}

function artifact(ociDigest: string, apps: unknown[]): DeploymentCatalogueArtifact {
  const catalogue = bytes({ schema_version: 1, generated_from_commit: SOURCE_SHA, apps })
  const plugins = Object.fromEntries(
    apps.map((value) => {
      const item = value as ReturnType<typeof app>
      return [item.id, { artifact: `${item.plugin.repository}@${item.plugin.digest}` }]
    }),
  )
  const pluginLock = Buffer.from(JSON.stringify({ schemaVersion: 1, plugins }))
  const materials = [
    { uri: "schema/catalogue-v1.schema.json", digest: `sha256:${"5".repeat(64)}` },
    {
      uri: "catalogue/plugin-lock.json",
      digest: deploymentCatalogueSchemaInternals.digest(pluginLock),
    },
    ...apps.map((value) => {
      const plugin = (value as ReturnType<typeof app>).plugin
      return { uri: `${plugin.repository}@${plugin.digest}`, digest: plugin.digest }
    }),
  ]
  const provenance = bytes({
    schema_version: 1,
    repository: "MySproutOS/Deployment-Templates",
    workflow: ".github/workflows/publish.yml",
    ref: "refs/heads/main",
    source_commit: SOURCE_SHA,
    subject: {
      kind: "catalogue",
      name: "catalogue/catalogue.json",
      digest: deploymentCatalogueSchemaInternals.digest(catalogue),
    },
    materials,
  })
  return {
    ociDigest,
    catalogue,
    provenance,
    pluginLock,
  }
}

async function cleanup(): Promise<void> {
  if (!reachable) return
  await db.deleteFrom("storeListing").where("catalogueEntryId", "=", APP_ID).execute()
  await db
    .deleteFrom("deploymentCatalogueImport")
    .where("ociDigest", "in", [FIRST_OCI_DIGEST, SECOND_OCI_DIGEST, REFUSED_OCI_DIGEST])
    .execute()
}

afterAll(async () => {
  await cleanup()
  await db.destroy()
})

describe("signed manifest structural preflight", () => {
  it("rejects environment collisions before service provisioning", () => {
    const fixture = {
      ...app(),
      user_inputs: [
        {
          key: "database_override",
          type: "string",
          environment: "DATABASE_URL",
          required: false,
        },
      ],
    }
    expect(() => parseCatalogueAppManifest(fixture)).toThrow("environment is not globally unique")
  })

  it("rejects outputs a service kind cannot provide", () => {
    const fixture = app()
    fixture.services[0].bindings = [{ environment: "REGION", output: "region" }]
    expect(() => parseCatalogueAppManifest(fixture)).toThrow("output is not provided by postgres")
  })

  it("rejects unsorted structural declarations", () => {
    const fixture = {
      ...app(),
      user_inputs: [
        { key: "zulu", type: "string", environment: "ZULU", required: false },
        { key: "alpha", type: "string", environment: "ALPHA", required: false },
      ],
    }
    expect(() => parseCatalogueAppManifest(fixture)).toThrow("must be strictly sorted")
  })
})

describe.skipIf(!reachable)("signed deployment catalogue reconciliation", () => {
  it("upserts blocked entries as non-public and archives entries removed by the next digest", async () => {
    await cleanup()
    const first = artifact(FIRST_OCI_DIGEST, [app()])
    await reconcileSignedDeploymentCatalogue(db, FIRST_OCI_DIGEST, SOURCE_SHA, {
      pull: () => Promise.resolve(first),
      verify: () => Promise.resolve([{ verified: true }]),
    })

    const imported = await db
      .selectFrom("storeListing")
      .select(["status", "catalogueImportId", "capabilityVerifiedAt", "e2eVerifiedAt"])
      .where("catalogueEntryId", "=", APP_ID)
      .executeTakeFirstOrThrow()
    expect(imported.status).toBe("draft")
    expect(imported.catalogueImportId).not.toBeNull()
    expect(imported.capabilityVerifiedAt).toBeNull()
    expect(imported.e2eVerifiedAt).toBeNull()
    await expect(
      db
        .updateTable("storeListing")
        .set({ status: "published" })
        .where("catalogueEntryId", "=", APP_ID)
        .execute(),
    ).rejects.toThrow(/store_listing_catalogue_publication_check/)

    const second = artifact(SECOND_OCI_DIGEST, [])
    const result = await reconcileSignedDeploymentCatalogue(db, SECOND_OCI_DIGEST, SOURCE_SHA, {
      pull: () => Promise.resolve(second),
      verify: () => Promise.resolve([{ verified: true }]),
    })
    expect(result.archived).toBe(1)
    const archived = await db
      .selectFrom("storeListing")
      .select(["status", "catalogueArchivedAt"])
      .where("catalogueEntryId", "=", APP_ID)
      .executeTakeFirstOrThrow()
    expect(archived.status).toBe("archived")
    expect(archived.catalogueArchivedAt).not.toBeNull()
  })

  it("performs no database writes when signature or provenance verification fails", async () => {
    await cleanup()
    const refused = artifact(REFUSED_OCI_DIGEST, [app()])
    await expect(
      reconcileSignedDeploymentCatalogue(db, REFUSED_OCI_DIGEST, SOURCE_SHA, {
        pull: () => Promise.resolve(refused),
        verify: () => Promise.reject(new Error("signature refused")),
      }),
    ).rejects.toThrow("signature refused")

    expect(
      await db
        .selectFrom("deploymentCatalogueImport")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("ociDigest", "=", REFUSED_OCI_DIGEST)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" })
    expect(
      await db
        .selectFrom("storeListing")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("catalogueEntryId", "=", APP_ID)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" })
  })

  it("rejects a non-canonical catalogue before reconciliation", async () => {
    await cleanup()
    const refused = artifact(REFUSED_OCI_DIGEST, [app()])
    refused.catalogue = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(refused.catalogue).toString("utf8")), null, 2),
    )
    await expect(
      reconcileSignedDeploymentCatalogue(db, REFUSED_OCI_DIGEST, SOURCE_SHA, {
        pull: () => Promise.resolve(refused),
        verify: () => Promise.resolve([{ verified: true }]),
      }),
    ).rejects.toThrow(/canonical JSON/)
  })

  it("rejects plugin-lock bytes that do not match signed provenance", async () => {
    await cleanup()
    const refused = artifact(REFUSED_OCI_DIGEST, [app()])
    refused.pluginLock = Buffer.from(`${Buffer.from(refused.pluginLock).toString("utf8")}\n`)
    await expect(
      reconcileSignedDeploymentCatalogue(db, REFUSED_OCI_DIGEST, SOURCE_SHA, {
        pull: () => Promise.resolve(refused),
        verify: () => Promise.resolve([{ verified: true }]),
      }),
    ).rejects.toThrow(/plugin-lock bytes/)
  })
})

describe("catalogue OIDC workflow policy", () => {
  const trusted = {
    repository: "MySproutOS/Deployment-Templates",
    ref: "refs/heads/main",
    workflowRef: "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main",
    sha: SOURCE_SHA,
  }

  it("accepts only the exact main publication workflow identity", () => {
    expect(isTrustedDeploymentCatalogueWorkflow(trusted)).toBe(true)
    expect(isTrustedDeploymentCatalogueWorkflow({ ...trusted, ref: "refs/pull/1/merge" })).toBe(
      false,
    )
    expect(
      isTrustedDeploymentCatalogueWorkflow({
        ...trusted,
        workflowRef: "MySproutOS/Deployment-Templates/.github/workflows/ci.yml@refs/heads/main",
      }),
    ).toBe(false)
    expect(
      isTrustedDeploymentCatalogueWorkflow({
        ...trusted,
        repository: "attacker/Deployment-Templates",
      }),
    ).toBe(false)
    expect(
      isTrustedDeploymentCatalogueWorkflow({ ...trusted, sha: SOURCE_SHA.toUpperCase() }),
    ).toBe(false)
  })
})
