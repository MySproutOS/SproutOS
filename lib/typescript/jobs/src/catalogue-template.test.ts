import { describe, expect, it } from "vitest"
import { SecretNotRecoverableError, type ServiceDriver } from "@lib/services"
import {
  catalogueTemplateApplyRequest,
  orchestrateCatalogueTemplate,
  reconcileTemplateServiceProvision,
  recoverTemplateService,
  validateCatalogueUserInputs,
  type CatalogueTemplateContext,
} from "./catalogue-template"

function serializedExecutor(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve()
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail
    const next = deferred()
    tail = next.promise
    await previous
    try {
      return await work()
    } finally {
      next.resolve()
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let complete: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: () => complete?.(),
  }
}

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

describe("catalogue template service recovery", () => {
  const first = {
    connectionUri: "postgres://tenant:first@example.test/database",
    host: "example.test",
    port: 5432,
    database: "database",
    username: "tenant",
  }
  const recovered = {
    ...first,
    connectionUri: "postgres://tenant:recovered@example.test/database",
  }

  function driver(overrides: Partial<ServiceDriver>): ServiceDriver {
    return {
      kind: "postgres",
      provision: () => Promise.reject(new Error("must not provision")),
      connectionUri: () => Promise.reject(new Error("connection unavailable")),
      details: () => Promise.resolve(first),
      rotateCredentials: () => Promise.reject(new Error("must not rotate")),
      suspend: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
      ...overrides,
    }
  }

  it("reconstructs a recoverable credential without rotating it", async () => {
    let rotations = 0
    const result = await recoverTemplateService(
      driver({
        connectionUri: () => Promise.resolve(first.connectionUri),
        rotateCredentials: () => {
          rotations += 1
          return Promise.resolve({ connectionUri: recovered.connectionUri })
        },
      }),
      "service-1",
    )

    expect(result).toEqual(first)
    expect(rotations).toBe(0)
  })

  it("rotates an unrecoverable secret on the same backend service", async () => {
    let rotations = 0
    const result = await recoverTemplateService(
      driver({
        connectionUri: () => Promise.reject(new SecretNotRecoverableError("service-1")),
        rotateCredentials: () => {
          rotations += 1
          return Promise.resolve({ connectionUri: recovered.connectionUri })
        },
      }),
      "service-1",
    )

    expect(result).toEqual(recovered)
    expect(rotations).toBe(1)
  })

  it("resumes the persisted service after a crash without provisioning another provider resource", async () => {
    let record: { backendServiceId: string; provisioned: boolean } | undefined
    let provisionCalls = 0
    let recoveryCalls = 0
    let bindingAttempts = 0
    const bindings = new Map<string, string>()

    const operations = {
      serialized: serializedExecutor(),
      load: () => Promise.resolve(record),
      create: () => {
        record = { backendServiceId: "service-1", provisioned: false }
        return Promise.resolve(record)
      },
      provision: () => {
        provisionCalls += 1
        return Promise.resolve(first)
      },
      recover: () => {
        recoveryCalls += 1
        return Promise.resolve(recovered)
      },
      persistBindings: (result: typeof first) => {
        bindingAttempts += 1
        bindings.set("DATABASE_URL", result.connectionUri)
        if (bindingAttempts === 1) return Promise.reject(new Error("worker crashed"))
        return Promise.resolve()
      },
      finish: () => {
        record!.provisioned = true
        return Promise.resolve()
      },
      fail: () => Promise.resolve(),
    }

    await expect(reconcileTemplateServiceProvision(operations)).rejects.toThrow("worker crashed")
    await reconcileTemplateServiceProvision(operations)
    await reconcileTemplateServiceProvision(operations)

    expect(provisionCalls).toBe(1)
    expect(recoveryCalls).toBe(1)
    expect(bindingAttempts).toBe(2)
    expect(bindings.get("DATABASE_URL")).toBe(recovered.connectionUri)
    expect(record?.provisioned).toBe(true)
  })

  it("keeps a failed recovery retryable and never falls back to a second provision", async () => {
    const record = { backendServiceId: "service-1", provisioned: false }
    let recoveryCalls = 0
    let failCalls = 0
    const operations = {
      serialized: serializedExecutor(),
      load: () => Promise.resolve(record),
      create: () => Promise.reject(new Error("must not create")),
      provision: () => Promise.reject(new Error("must not provision")),
      recover: () => {
        recoveryCalls += 1
        return recoveryCalls === 1
          ? Promise.reject(new Error("provider state unavailable"))
          : Promise.resolve(recovered)
      },
      persistBindings: () => Promise.resolve(),
      finish: () => {
        record.provisioned = true
        return Promise.resolve()
      },
      fail: () => {
        failCalls += 1
        return Promise.resolve()
      },
    }

    await expect(reconcileTemplateServiceProvision(operations)).rejects.toThrow(
      "provider state unavailable",
    )
    await reconcileTemplateServiceProvision(operations)

    expect(recoveryCalls).toBe(2)
    expect(failCalls).toBe(1)
    expect(record.provisioned).toBe(true)
  })

  it("serializes concurrent retries so only one credential reaches the bindings", async () => {
    let record: { backendServiceId: string; provisioned: boolean } | undefined
    let createCalls = 0
    let provisionCalls = 0
    let recoveryCalls = 0
    const provisionStarted = deferred()
    const provisionBlocked = deferred()
    const operations = {
      serialized: serializedExecutor(),
      load: () => Promise.resolve(record),
      create: () => {
        createCalls += 1
        record = { backendServiceId: "service-1", provisioned: false }
        return Promise.resolve(record)
      },
      provision: async () => {
        provisionCalls += 1
        provisionStarted.resolve()
        await provisionBlocked.promise
        return first
      },
      recover: () => {
        recoveryCalls += 1
        return Promise.resolve(recovered)
      },
      persistBindings: () => Promise.resolve(),
      finish: () => {
        record!.provisioned = true
        return Promise.resolve()
      },
      fail: () => Promise.resolve(),
    }

    const one = reconcileTemplateServiceProvision(operations)
    const two = reconcileTemplateServiceProvision(operations)
    await provisionStarted.promise
    provisionBlocked.resolve()
    await Promise.all([one, two])

    expect(createCalls).toBe(1)
    expect(provisionCalls).toBe(1)
    expect(recoveryCalls).toBe(0)
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
