import { describe, expect, it } from "vitest"
import { ACME_HANDLERS, JOB_KINDS, PLATFORM_HANDLERS } from "./handlers"

/**
 * A declared job kind with no handler is invisible, not loud.
 *
 * `claim` selects by the kinds the worker has handlers for, so a job whose kind is missing from
 * `PLATFORM_HANDLERS` is never claimed, never fails, never retries and never appears in any
 * failure count. It sits in `background_job` at state `queued` forever while the feature that
 * enqueued it looks like it is working — the enqueue succeeded, after all.
 *
 * That is exactly how fork upkeep shipped broken: `upkeep.scan` fanned out one `upkeep.repository`
 * job per due repository, and nothing was registered to run them. The scan logged "scheduled 12
 * repositories" every night and twelve rows accumulated, untouched.
 *
 * The registry is the contract. This asserts the two halves cannot drift apart again.
 */
describe("PLATFORM_HANDLERS", () => {
  it("does not expose the retired Postgres raw-usage rollup kind", () => {
    expect(Object.values(JOB_KINDS)).not.toContain("billing.roll_up_usage")
    expect(PLATFORM_HANDLERS["billing.roll_up_usage"]).toBeUndefined()
  })

  it("registers a handler for every declared job kind", () => {
    const handlers = { ...PLATFORM_HANDLERS, ...ACME_HANDLERS }
    const missing = Object.entries(JOB_KINDS)
      .filter(([, kind]) => typeof handlers[kind] !== "function")
      .map(([name, kind]) => `${name} ("${kind}")`)

    expect(missing).toEqual([])
  })

  it("registers no handler for a kind nothing declares", () => {
    // The other direction. A handler under a kind no caller can enqueue is dead code that reads
    // as coverage, and it is how a typo in a kind string hides.
    const declared = new Set<string>(Object.values(JOB_KINDS))
    const orphans = Object.keys({ ...PLATFORM_HANDLERS, ...ACME_HANDLERS }).filter(
      (kind) => !declared.has(kind),
    )

    expect(orphans).toEqual([])
  })

  it("keeps privileged certificate kinds out of the ordinary worker", () => {
    expect(Object.keys(ACME_HANDLERS).toSorted()).toEqual(
      [
        JOB_KINDS.customDomainReconcile,
        JOB_KINDS.customDomainScan,
        JOB_KINDS.publishRelease,
        JOB_KINDS.reconcilePlatformEdgeCertificate,
        JOB_KINDS.tearDownPreview,
        JOB_KINDS.cleanUpStaticPreview,
        JOB_KINDS.tearDownAccount,
        JOB_KINDS.tearDownProject,
      ].toSorted(),
    )
    for (const kind of Object.keys(ACME_HANDLERS)) {
      expect(PLATFORM_HANDLERS[kind]).toBeUndefined()
    }
  })

  it("keeps account teardown with the privileged project teardown it invokes", () => {
    expect(ACME_HANDLERS[JOB_KINDS.tearDownAccount]).toBeTypeOf("function")
    expect(PLATFORM_HANDLERS[JOB_KINDS.tearDownAccount]).toBeUndefined()
  })

  it("fails visibly when the authoritative ClickHouse importer is unconfigured", async () => {
    const previous = process.env.CLICKHOUSE_URL
    delete process.env.CLICKHOUSE_URL
    try {
      const handler = PLATFORM_HANDLERS[JOB_KINDS.importUsage]
      expect(handler).toBeTypeOf("function")
      if (handler === undefined) throw new Error("ClickHouse importer is not registered")
      await expect(handler({} as never, { db: {} } as never)).rejects.toThrow(
        "CLICKHOUSE_URL is not set; authoritative usage rollups cannot be imported into billing",
      )
    } finally {
      if (previous === undefined) delete process.env.CLICKHOUSE_URL
      else process.env.CLICKHOUSE_URL = previous
    }
  })

  it("fails visibly when OpenSearch reconciliation has no derivation root", async () => {
    const previous = process.env.SEARCH_PROXY_SECURITY_ROOT_KEY
    delete process.env.SEARCH_PROXY_SECURITY_ROOT_KEY
    try {
      const handler = PLATFORM_HANDLERS[JOB_KINDS.reconcileSearchSecurity]
      expect(handler).toBeTypeOf("function")
      if (handler === undefined) throw new Error("OpenSearch reconciliation is not registered")
      await expect(handler({} as never, { db: {} } as never)).rejects.toThrow(
        "SEARCH_PROXY_SECURITY_ROOT_KEY is not set; OpenSearch tenant identities cannot be reconciled",
      )
    } finally {
      if (previous === undefined) delete process.env.SEARCH_PROXY_SECURITY_ROOT_KEY
      else process.env.SEARCH_PROXY_SECURITY_ROOT_KEY = previous
    }
  })

  it("fails visibly when Valkey reconciliation has no derivation root", async () => {
    const previous = process.env.VALKEY_PROXY_ACL_ROOT_KEY
    delete process.env.VALKEY_PROXY_ACL_ROOT_KEY
    try {
      const handler = PLATFORM_HANDLERS[JOB_KINDS.reconcileValkeyAcl]
      expect(handler).toBeTypeOf("function")
      if (handler === undefined) throw new Error("Valkey ACL reconciliation is not registered")
      await expect(handler({} as never, { db: {} } as never)).rejects.toThrow(
        "VALKEY_PROXY_ACL_ROOT_KEY is not set; Valkey tenant ACL users cannot be reconciled",
      )
    } finally {
      if (previous === undefined) delete process.env.VALKEY_PROXY_ACL_ROOT_KEY
      else process.env.VALKEY_PROXY_ACL_ROOT_KEY = previous
    }
  })
})
