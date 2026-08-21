import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { tenantKeyPrefix } from "./valkey"

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
describe("the tenant key prefix the reaper deletes by", () => {
  it("matches the prefix the proxy writes under", () => {
    const queues = vectors().filter((vector) => vector.kind === "queue")
    expect(queues.length).toBeGreaterThan(0)

    for (const vector of queues) {
      expect(tenantKeyPrefix(vector.resourceId)).toBe(vector.keyPrefix)
    }
  })

  /*
    One prefix per resource, not per organization.

    A customer with a queue for emails and a queue for video encoding would otherwise find both
    writing `bull:jobs:wait` into the same place — and destroying one would reap the other.
  */
  it("gives two resources two prefixes", () => {
    const cases = vectors()
    expect(new Set(cases.map((vector) => vector.keyPrefix)).size).toBe(cases.length)
  })
})
