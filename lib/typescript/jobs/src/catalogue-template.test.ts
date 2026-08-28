import { describe, expect, it } from "vitest"
import {
  catalogueTemplateApplyRequest,
  orchestrateCatalogueTemplate,
  validateCatalogueUserInputs,
  type CatalogueTemplateContext,
} from "./catalogue-template"

describe("catalogue template lifecycle", () => {
  it("provisions services before forking and applies core before deployment", async () => {
    const events: string[] = []
    const repository = await orchestrateCatalogueTemplate({
      transition: (state) => {
        events.push(`state:${state}`)
        return Promise.resolve()
      },
      configure: () => {
        events.push("configure")
        return Promise.resolve()
      },
      provisionServices: () => {
        events.push("services")
        return Promise.resolve()
      },
      fork: () => {
        events.push("fork")
        return Promise.resolve({ id: 42 })
      },
      prepareAndPush: ({ id }) => {
        events.push(`core:${id}`)
        return Promise.resolve()
      },
    })

    expect(repository).toEqual({ id: 42 })
    expect(events).toEqual([
      "state:configuring",
      "configure",
      "state:provisioning",
      "services",
      "state:forking",
      "fork",
      "state:preparing",
      "core:42",
      "state:deploying",
    ])
  })

  it("does not fork when service provisioning fails", async () => {
    const events: string[] = []
    await expect(
      orchestrateCatalogueTemplate({
        transition: (state) => {
          events.push(`state:${state}`)
          return Promise.resolve()
        },
        configure: () => Promise.resolve(),
        provisionServices: () => Promise.reject(new Error("database unavailable")),
        fork: () => {
          events.push("fork")
          return Promise.resolve(null)
        },
        prepareAndPush: () => Promise.resolve(),
      }),
    ).rejects.toThrow("database unavailable")
    expect(events).not.toContain("fork")
  })
})

describe("catalogue user inputs", () => {
  const definitions = [
    { key: "title", type: "string" as const, environment: "SITE_TITLE", required: true },
    { key: "origin", type: "url" as const, environment: "PUBLIC_ORIGIN", required: false },
    { key: "workers", type: "integer" as const, environment: "WORKERS", required: false },
    { key: "enabled", type: "boolean" as const, environment: "ENABLED", required: false },
  ]

  it("resolves exact signed keys and preserves secret policy", () => {
    expect(
      validateCatalogueUserInputs(definitions, [
        { key: "title", value: "Private site", secret: true },
        { key: "origin", value: "https://example.com/path", secret: false },
        { key: "workers", value: 3, secret: false },
        { key: "enabled", value: true, secret: false },
      ]),
    ).toEqual([
      { key: "title", environment: "SITE_TITLE", value: "Private site", secret: true },
      {
        key: "origin",
        environment: "PUBLIC_ORIGIN",
        value: "https://example.com/path",
        secret: false,
      },
      { key: "workers", environment: "WORKERS", value: "3", secret: false },
      { key: "enabled", environment: "ENABLED", value: "true", secret: false },
    ])
  })

  it("keeps customer values and reveal flags outside the native plugin request", () => {
    const context = {
      projectId: "project",
      organizationId: "organization",
      catalogueDigest: `sha256:${"1".repeat(64)}`,
      manifestDigest: `sha256:${"2".repeat(64)}`,
      pluginRepository: "ghcr.io/mysproutos/test",
      pluginDigest: `sha256:${"3".repeat(64)}`,
      deploymentTemplatesCommit: "4".repeat(40),
      preparedCommitSha: null,
      configuredInputs: [{ key: "title", environment: "SITE_TITLE", secret: true }],
      manifest: {
        schema_version: 1,
        id: "test",
        name: "Test",
        pitch: "Test",
        description_md: "Test",
        homepage: null,
        repository: { url: "https://github.com/example/test", commit: "5".repeat(40) },
        license: "MIT",
        platform: "web",
        readiness: { status: "live", blocked_reasons: [], e2e_evidence: null },
        plugin: {
          repository: "ghcr.io/mysproutos/test",
          digest: `sha256:${"3".repeat(64)}`,
          protocol_version: 1,
        },
        deployment: {
          preset: "static",
          runtime: "static",
          architecture: "arm64",
          migration: null,
          required_capabilities: [],
        },
        services: [],
        user_inputs: definitions,
        generated_inputs: [],
      },
    } satisfies CatalogueTemplateContext
    const request = JSON.stringify(catalogueTemplateApplyRequest(context))
    expect(request).toContain('"user_inputs"')
    expect(request).not.toContain("configuredInputs")
    expect(request).not.toContain('"secret"')
    expect(request).not.toContain("top-secret")
  })

  it.each([
    [[], "required template input title is missing"],
    [[{ key: "other", value: "x", secret: false }], "template input other is not declared"],
    [
      [
        { key: "title", value: "one", secret: false },
        { key: "title", value: "two", secret: false },
      ],
      "template input title was supplied more than once",
    ],
    [[{ key: "title", value: 1, secret: false }], "title must be a string"],
    [
      [
        { key: "title", value: "ok", secret: false },
        { key: "origin", value: "javascript:alert(1)", secret: false },
      ],
      "origin must be an HTTP(S) URL without embedded credentials",
    ],
  ])("fails closed before orchestration for %#", (submitted, message) => {
    expect(() => validateCatalogueUserInputs(definitions, submitted)).toThrow(message)
  })
})
