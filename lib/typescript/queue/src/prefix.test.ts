import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BULLMQ_PREFIX, tenantQueuePrefix } from "./prefix"

/**
 * The shared naming vectors — the same file `lib/rust/tenant-auth` and `services/valkey-proxy`
 * assert against.
 */
function vectors(): { kind: string; resourceId: string; keyPrefix: string }[] {
  const path = join(import.meta.dirname, "../../../rust/tenant-auth/fixtures/naming-vectors.json")
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    cases: { kind: string; resourceId: string; keyPrefix: string }[]
  }
  // An empty array would make every loop below vacuous, which is the shape of the bug this file
  // exists to prevent.
  expect(parsed.cases.length).toBeGreaterThan(2)
  return parsed.cases
}

/*
  Three implementations of one prefix, and until now no vector.

  `keyspace::prefix_for` in the Rust proxy writes every tenant key under it. `tenantKeyPrefix` in
  `@lib/reaper` deletes by it when a service is destroyed. `tenantQueuePrefix` in `@lib/queue` reads
  a tenant's queue depth. They agreed, and nothing said so — and the failure mode is not an error:
  the reaper matches nothing, reports success, and a deleted customer's queue stays in the shared
  instance forever.

  The same treatment the database and role names got, which had already drifted once between these
  two languages while both test suites stayed green.
*/
describe("the tenant queue prefix", () => {
  /*
    Two halves, applied in order.

    The proxy prepends `{kv:…}:` and the tenant's BullMQ prepends `bull`, so a key in the shared
    instance carries both. The control plane connects directly rather than through the proxy — it
    cannot authenticate as a tenant, whose secret is stored as a one-way hash — so it applies both
    halves itself, and getting either half wrong reads an empty queue rather than erroring.
  */
  it("is the proxy's prefix followed by BullMQ's own", () => {
    const queues = vectors().filter((vector) => vector.kind === "queue")
    expect(queues.length).toBeGreaterThan(0)

    for (const vector of queues) {
      expect(tenantQueuePrefix(vector.resourceId)).toBe(`${vector.keyPrefix}${BULLMQ_PREFIX}`)
    }
  })
})
