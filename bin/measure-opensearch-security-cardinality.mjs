#!/usr/bin/env node
/*
 * Destructive load measurement for a disposable secured OpenSearch cluster.
 *
 * Creates one internal user, role, and mapping per synthetic tenant at each requested tier, records
 * bulk config-write time, full-list latency/bytes, JVM heap, and authentication latency, then
 * removes only the `sproutos_benchmark_*` documents it created. It never runs without the explicit
 * acknowledgement below and refuses a non-loopback URL unless separately overridden.
 */
import process from "node:process"

if (process.env.OPENSEARCH_CARDINALITY_ACK !== "benchmark-disposable-cluster") {
  throw new Error(
    "Set OPENSEARCH_CARDINALITY_ACK=benchmark-disposable-cluster; this creates many Security documents",
  )
}

const base = (process.env.SEARCH_ADMIN_URL ?? "http://127.0.0.1:29200").replace(/\/+$/, "")
const parsed = new URL(base)
if (
  !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) &&
  process.env.OPENSEARCH_CARDINALITY_ALLOW_REMOTE !== "1"
) {
  throw new Error("Refusing a non-loopback cluster without OPENSEARCH_CARDINALITY_ALLOW_REMOTE=1")
}
const adminUser = process.env.SEARCH_ADMIN_USER ?? "admin"
const adminPassword = process.env.SEARCH_ADMIN_PASSWORD
if (adminPassword === undefined) throw new Error("SEARCH_ADMIN_PASSWORD is required")
const tiers = (process.env.OPENSEARCH_SECURITY_CARDINALITY_TIERS ?? "1000,10000,100000")
  .split(",")
  .map(Number)
if (tiers.length === 0 || tiers.some((tier) => !Number.isSafeInteger(tier) || tier < 1)) {
  throw new Error("OPENSEARCH_SECURITY_CARDINALITY_TIERS must contain positive integers")
}
tiers.sort((left, right) => left - right)
const batchSize = Number(process.env.OPENSEARCH_SECURITY_CARDINALITY_BATCH ?? 250)
if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("invalid batch size")

const benchmarkPassword = "Benchmark-only-credential-83!"
// A test-only bcrypt hash. It avoids measuring 100k repeated bcrypt computations when the scaling
// axis under test is Security config cardinality/reload, not password hashing.
const benchmarkHash = "$2y$12$obXw/.1Lnq9.KxcLxlZ69.1MdsZ5S/1KujrVywrP/ixEoaLsWdH3S"
const prefix = "sproutos_benchmark_"
const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`
const created = []

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization, "content-type": "application/json", ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`)
  return text
}

function name(index) {
  return `${prefix}${String(index).padStart(6, "0")}`
}

async function patch(endpoint, operations) {
  const started = performance.now()
  await request(`/_plugins/_security/api/${endpoint}`, {
    method: "PATCH",
    body: JSON.stringify(operations),
  })
  return performance.now() - started
}

async function addRange(from, to) {
  const elapsed = { roles: 0, users: 0, mappings: 0 }
  for (let start = from; start < to; start += batchSize) {
    const end = Math.min(to, start + batchSize)
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset)
    elapsed.roles += await patch(
      "roles",
      indexes.map((index) => ({
        op: "add",
        path: `/${name(index)}`,
        value: {
          cluster_permissions: ["cluster_composite_ops"],
          index_permissions: [
            { index_patterns: [`benchmark_${index}_*`], allowed_actions: ["read", "write"] },
          ],
          tenant_permissions: [],
        },
      })),
    )
    elapsed.users += await patch(
      "internalusers",
      indexes.map((index) => ({
        op: "add",
        path: `/${name(index)}`,
        value: {
          hash: benchmarkHash,
          backend_roles: [name(index)],
          attributes: { sproutos_benchmark: "cardinality-v1" },
        },
      })),
    )
    elapsed.mappings += await patch(
      "rolesmapping",
      indexes.map((index) => ({
        op: "add",
        path: `/${name(index)}`,
        value: { backend_roles: [name(index)], hosts: [], users: [name(index)] },
      })),
    )
    created.push(...indexes)
  }
  return elapsed
}

async function listMeasurement(endpoint) {
  const started = performance.now()
  const body = await request(`/_plugins/_security/api/${endpoint}`)
  return { ms: performance.now() - started, bytes: Buffer.byteLength(body) }
}

async function cleanup() {
  const unique = [...new Set(created)]
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize)
    for (const endpoint of ["internalusers", "rolesmapping", "roles"]) {
      await patch(
        endpoint,
        batch.map((index) => ({ op: "remove", path: `/${name(index)}` })),
      )
    }
  }
}

try {
  let populated = 0
  for (const tier of tiers) {
    const writes = await addRange(populated, tier)
    populated = tier
    const roles = await listMeasurement("roles")
    const users = await listMeasurement("internalusers")
    const mappings = await listMeasurement("rolesmapping")
    const authStarted = performance.now()
    const authResponse = await fetch(`${base}/`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${name(tier - 1)}:${benchmarkPassword}`).toString("base64")}`,
      },
    })
    const authMs = performance.now() - authStarted
    if (authResponse.status !== 200 && authResponse.status !== 403) {
      throw new Error(`benchmark authentication returned ${authResponse.status}`)
    }
    const nodes = JSON.parse(await request("/_nodes/stats/jvm?filter_path=nodes.*.jvm.mem"))
    const memory = Object.values(nodes.nodes ?? {})[0]?.jvm?.mem ?? {}
    process.stdout.write(
      `${JSON.stringify({ tier, writeMs: writes, list: { roles, users, mappings }, authMs, heapUsedBytes: memory.heap_used_in_bytes, heapCommittedBytes: memory.heap_committed_in_bytes })}\n`,
    )
  }
} finally {
  if (process.env.OPENSEARCH_SECURITY_CARDINALITY_KEEP !== "1") await cleanup()
}
