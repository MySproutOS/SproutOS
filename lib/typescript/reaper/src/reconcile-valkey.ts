import { Redis } from "ioredis"
import {
  expectedValkeyAclTokens,
  valkeyAclSetUserArgs,
  valkeyAclUsername,
  type ValkeyAclIdentity,
} from "@lib/services"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/** Warning threshold only; crossing it never refuses provisioning or traffic. */
export const VALKEY_ACL_CARDINALITY_SOFT_LIMIT = 1_000
export const VALKEY_ACL_REPAIRS_PER_PASS = 100
export const VALKEY_ACL_INSPECTIONS_PER_PASS = 1_000

export type ValkeyAclReconciliation = {
  expected: number
  observed: number
  missing: number
  drifted: number
  orphaned: number
  repaired: number
  inspected: number
  pendingInspections: number
  pendingRepairs: number
  listLatencyMs: number
  repairLatencyMs: number
  softLimit: number
  softLimitExceeded: boolean
}

type AclRedis = {
  call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown>
}

export async function reconcileValkeyAcl(
  db: Kysely<DB>,
  adminUrl: string,
  rootKey: string,
  options: ReconcileOptions = {},
): Promise<ValkeyAclReconciliation> {
  const services = await db
    .selectFrom("backendService as service")
    .innerJoin("organization as organization", "organization.id", "service.organizationId")
    .select(["service.id", "service.organizationId"])
    .where("service.kind", "=", "valkey")
    .where("service.deletedAt", "is", null)
    .where("service.status", "in", ["provisioning", "active"])
    .where("organization.deletedAt", "is", null)
    .orderBy("service.id")
    .execute()
  const redis = new Redis(adminUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    commandTimeout: 60_000,
  })
  try {
    await redis.connect()
    return await reconcileValkeyAclIdentities(redis, services, rootKey, options)
  } finally {
    redis.disconnect()
  }
}

export type ReconcileOptions = {
  softLimit?: number
  repairLimit?: number
  inspectionLimit?: number
  inspectionOffset?: number
}

export async function reconcileValkeyAclIdentities(
  redis: AclRedis,
  identities: ValkeyAclIdentity[],
  rootKey: string,
  options: ReconcileOptions = {},
): Promise<ValkeyAclReconciliation> {
  if (Buffer.byteLength(rootKey) < 32) {
    throw new Error("VALKEY_PROXY_ACL_ROOT_KEY must contain at least 32 bytes")
  }
  const softLimit = positive(options.softLimit ?? VALKEY_ACL_CARDINALITY_SOFT_LIMIT, "soft limit")
  const repairLimit = positive(options.repairLimit ?? VALKEY_ACL_REPAIRS_PER_PASS, "repair limit")
  const inspectionLimit = positive(
    options.inspectionLimit ?? VALKEY_ACL_INSPECTIONS_PER_PASS,
    "inspection limit",
  )

  const listStarted = performance.now()
  const raw = await redis.call("ACL", "LIST")
  if (!Array.isArray(raw) || !raw.every((line) => typeof line === "string")) {
    throw new TypeError("ACL LIST returned an unexpected response")
  }
  const lines = raw
  const listLatencyMs = performance.now() - listStarted
  const actual = new Map(
    lines.flatMap((line) => {
      const match = /^user ([^ ]+) /.exec(line)
      return match === null ? [] : [[match[1], line] as const]
    }),
  )
  const expected = identities.map((identity) => ({
    identity,
    username: valkeyAclUsername(identity),
  }))
  const expectedNames = new Set(expected.map(({ username }) => username))
  const missing = expected.filter(({ username }) => !actual.has(username))

  const present = expected.filter(({ username }) => actual.has(username))
  const offset =
    present.length === 0
      ? 0
      : (options.inspectionOffset ?? Math.floor(Date.now() / 3_600_000) * inspectionLimit) %
        present.length
  const inspected = cyclicWindow(present, offset, inspectionLimit)
  const drifted = inspected.filter(({ identity, username }) => {
    const line = actual.get(username)
    return line !== undefined && !sameTokens(line, expectedValkeyAclTokens(identity, rootKey))
  })

  const repairPlan = [...missing, ...drifted]
  const repairStarted = performance.now()
  for (const repair of repairPlan.slice(0, repairLimit)) {
    // Sequential on purpose: each ACL write mutates the engine's global authorization table.
    // eslint-disable-next-line no-await-in-loop
    await redis.call("ACL", "SETUSER", ...valkeyAclSetUserArgs(repair.identity, rootKey))
  }
  const repairLatencyMs = performance.now() - repairStarted
  const orphaned = [...actual.keys()].filter(
    (username) =>
      /^kv_[0-7][0-9a-hjkmnp-tv-z]{25}\.[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(username) &&
      !expectedNames.has(username),
  ).length
  const observed = [...actual.keys()].filter((username) =>
    /^kv_[0-7][0-9a-hjkmnp-tv-z]{25}\.[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(username),
  ).length
  const cardinality = Math.max(observed, expected.length)

  return {
    expected: expected.length,
    observed,
    missing: missing.length,
    drifted: drifted.length,
    orphaned,
    repaired: Math.min(repairPlan.length, repairLimit),
    inspected: inspected.length,
    pendingInspections: Math.max(0, present.length - inspected.length),
    pendingRepairs: Math.max(0, repairPlan.length - repairLimit),
    listLatencyMs,
    repairLatencyMs,
    softLimit,
    softLimitExceeded: cardinality >= softLimit,
  }
}

function sameTokens(line: string, expected: Set<string>): boolean {
  const actual = new Set(
    line
      .split(/\s+/u)
      .slice(2)
      .map((token) => token.toLowerCase()),
  )
  return actual.size === expected.size && [...actual].every((token) => expected.has(token))
}

function cyclicWindow<T>(values: T[], offset: number, limit: number): T[] {
  if (values.length <= limit) return values
  const start = ((offset % values.length) + values.length) % values.length
  return Array.from({ length: limit }, (_, index) => values[(start + index) % values.length])
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Valkey ACL ${label} must be a positive integer`)
  }
  return value
}
