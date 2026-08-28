import { createHash, createHmac } from "node:crypto"
import { tenantIndexPrefix, tenantUsername } from "@lib/services/tenant-auth"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { searchAdminRequest, type SearchAdminConfig } from "./search"

const MANAGED_VERSION = "search-v1"
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/**
 * Warning threshold, not a provisioning cap.
 *
 * Set at the first secured-cluster measurement tier. Crossing it keeps serving and makes the
 * hourly report warn; increasing it requires recording a new measurement in ADR 0029.
 */
export const SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT = 1_000
export const SEARCH_SECURITY_REPAIRS_PER_PASS = 100

const CLUSTER_PERMISSIONS = ["cluster_composite_ops", "cluster:monitor/main"]
const INDEX_ACTIONS = [
  "read",
  "write",
  "create_index",
  "indices_monitor",
  "indices:admin/refresh",
  "indices:admin/flush",
  "indices:admin/forcemerge",
  "indices:admin/analyze",
  "indices:data/read/point_in_time/*",
]

type SecurityDocument = Record<string, unknown>

function emptyDocumentCounts(): Record<"users" | "roles" | "mappings", number> {
  return { users: 0, roles: 0, mappings: 0 }
}

export type SearchSecurityReconciliation = {
  expected: number
  observed: { users: number; roles: number; mappings: number }
  missing: { users: number; roles: number; mappings: number }
  drifted: { users: number; roles: number; mappings: number }
  orphaned: { users: number; roles: number; mappings: number }
  repaired: { users: number; roles: number; mappings: number }
  listLatencyMs: number
  repairLatencyMs: number
  softLimit: number
  softLimitExceeded: boolean
  pendingRepairs: number
}

export async function reconcileSearchSecurity(
  db: Kysely<DB>,
  config: SearchAdminConfig,
  rootKey: string,
  softLimit = SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT,
  repairLimit = SEARCH_SECURITY_REPAIRS_PER_PASS,
): Promise<SearchSecurityReconciliation> {
  if (Buffer.byteLength(rootKey) < 32) {
    throw new Error("SEARCH_PROXY_SECURITY_ROOT_KEY must contain at least 32 bytes")
  }
  if (!Number.isSafeInteger(softLimit) || softLimit < 1) {
    throw new RangeError("OpenSearch Security soft limit must be a positive integer")
  }
  if (!Number.isSafeInteger(repairLimit) || repairLimit < 1) {
    throw new RangeError("OpenSearch Security repair limit must be a positive integer")
  }

  const services = await db
    .selectFrom("backendService")
    .select(["id", "organizationId"])
    .where("kind", "=", "elasticsearch")
    .where("deletedAt", "is", null)
    .orderBy("id", "desc")
    .execute()

  const listStarted = performance.now()
  const [roles, users, mappings] = await Promise.all([
    searchAdminRequest<Record<string, SecurityDocument>>(
      config,
      "GET",
      "/_plugins/_security/api/roles",
    ),
    searchAdminRequest<Record<string, SecurityDocument>>(
      config,
      "GET",
      "/_plugins/_security/api/internalusers",
    ),
    searchAdminRequest<Record<string, SecurityDocument>>(
      config,
      "GET",
      "/_plugins/_security/api/rolesmapping",
    ),
  ])
  const listLatencyMs = performance.now() - listStarted

  const expected = services.map((service) => desired(service, rootKey))
  const expectedUsers = new Set(expected.map((item) => item.username))
  const expectedRoles = new Set(expected.map((item) => item.role))
  const missing = emptyDocumentCounts()
  const drifted = emptyDocumentCounts()
  const repaired = emptyDocumentCounts()
  const repairPlan: Repair[] = []

  for (const item of expected) {
    classifyDocument("roles", item.role, item.roleDocument, roles, missing, drifted, repairPlan)
    classifyDocument(
      "internalusers",
      item.username,
      item.userDocument,
      users,
      missing,
      drifted,
      repairPlan,
    )
    classifyDocument(
      "rolesmapping",
      item.role,
      item.mappingDocument,
      mappings,
      missing,
      drifted,
      repairPlan,
    )
  }

  const repairStarted = performance.now()
  for (const repair of repairPlan.slice(0, repairLimit)) {
    // Each Security API write reloads cluster configuration; keep repair pressure deliberately
    // sequential and bounded rather than producing a reload storm with Promise.all.
    // eslint-disable-next-line no-await-in-loop
    await searchAdminRequest(
      config,
      "PUT",
      `/_plugins/_security/api/${repair.endpoint}/${encodeURIComponent(repair.name)}`,
      repair.wanted,
    )
    repaired[repair.label] += 1
  }
  const repairLatencyMs = performance.now() - repairStarted

  // Report only documents carrying our explicit marker/naming contract. They are intentionally not
  // deleted here: the deletion reaper has the soft-deleted Postgres row that proves ownership;
  // this live-service pass does not, and a lookalike operator-created document is not ours to erase.
  const orphaned = {
    users: Object.entries(users).filter(
      ([name, document]) => isManagedUser(document) && !expectedUsers.has(name),
    ).length,
    roles: Object.keys(roles).filter((name) => isManagedRole(name) && !expectedRoles.has(name))
      .length,
    mappings: Object.keys(mappings).filter(
      (name) => isManagedRole(name) && !expectedRoles.has(name),
    ).length,
  }
  const observed = {
    users: Object.values(users).filter(isManagedUser).length,
    roles: Object.keys(roles).filter(isManagedRole).length,
    mappings: Object.keys(mappings).filter(isManagedRole).length,
  }
  const cardinality = Math.max(observed.users, observed.roles, observed.mappings, expected.length)

  return {
    expected: expected.length,
    observed,
    missing,
    drifted,
    orphaned,
    repaired,
    listLatencyMs,
    repairLatencyMs,
    softLimit,
    softLimitExceeded: cardinality >= softLimit,
    pendingRepairs: Math.max(0, repairPlan.length - repairLimit),
  }
}

type Repair = {
  endpoint: "roles" | "internalusers" | "rolesmapping"
  label: "users" | "roles" | "mappings"
  name: string
  wanted: SecurityDocument
}

function classifyDocument(
  endpoint: "roles" | "internalusers" | "rolesmapping",
  name: string,
  wanted: SecurityDocument,
  existing: Record<string, SecurityDocument>,
  missing: Record<"users" | "roles" | "mappings", number>,
  drifted: Record<"users" | "roles" | "mappings", number>,
  repairPlan: Repair[],
): void {
  const label =
    endpoint === "internalusers" ? "users" : endpoint === "rolesmapping" ? "mappings" : "roles"
  const current = existing[name]
  if (current !== undefined && equivalent(endpoint, current, wanted)) return

  if (current === undefined) missing[label] += 1
  else drifted[label] += 1
  repairPlan.push({ endpoint, label, name, wanted })
}

function equivalent(
  endpoint: "roles" | "internalusers" | "rolesmapping",
  current: SecurityDocument,
  wanted: SecurityDocument,
): boolean {
  if (endpoint === "roles") {
    return (
      stable({
        cluster_permissions: current.cluster_permissions,
        index_permissions: normalizeIndexPermissions(current.index_permissions),
        tenant_permissions: current.tenant_permissions ?? [],
      }) === stable(wanted)
    )
  }
  const comparable = {
    backend_roles: current.backend_roles ?? [],
    ...(endpoint === "internalusers"
      ? { attributes: current.attributes ?? {} }
      : { hosts: current.hosts ?? [], users: current.users ?? [] }),
  }
  const wantedComparable = {
    backend_roles: wanted.backend_roles ?? [],
    ...(endpoint === "internalusers"
      ? { attributes: wanted.attributes ?? {} }
      : { hosts: wanted.hosts ?? [], users: wanted.users ?? [] }),
  }
  return stable(comparable) === stable(wantedComparable)
}

function normalizeIndexPermissions(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return (value as unknown[]).map((permission: unknown) => {
    if (typeof permission !== "object" || permission === null) return permission
    const item = permission as SecurityDocument
    return { index_patterns: item.index_patterns, allowed_actions: item.allowed_actions }
  })
}

function desired(service: { id: string; organizationId: string }, rootKey: string) {
  const prefix = tenantIndexPrefix(service.id)
  const role = `tenant_${prefix.replace(/_$/, "")}`
  const username = tenantUsername({
    organizationId: service.organizationId,
    kind: "searchIndex",
    resourceId: service.id,
  })
  const password = deriveSearchSecurityPassword(rootKey, username)
  return {
    username,
    role,
    roleDocument: {
      cluster_permissions: CLUSTER_PERMISSIONS,
      index_permissions: [{ index_patterns: [`${prefix}*`], allowed_actions: INDEX_ACTIONS }],
      tenant_permissions: [],
    },
    userDocument: {
      password,
      backend_roles: [role],
      attributes: {
        sproutos_managed: MANAGED_VERSION,
        sproutos_credential_sha256: createHash("sha256").update(password).digest("hex"),
      },
    },
    mappingDocument: { backend_roles: [role], hosts: [], users: [username] },
  }
}

export function deriveSearchSecurityPassword(rootKey: string, username: string): string {
  const digest = createHmac("sha256", rootKey)
    .update("sproutos:search-internal-user:v1\0")
    .update(username)
    .digest()
  let out = ""
  let accumulator = 0
  let bits = 0
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(accumulator >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += ALPHABET[(accumulator << (5 - bits)) & 0x1f]
  return out
}

function isManagedUser(document: SecurityDocument): boolean {
  const attributes = document.attributes
  return (
    typeof attributes === "object" &&
    attributes !== null &&
    (attributes as SecurityDocument).sproutos_managed === MANAGED_VERSION
  )
}

function isManagedRole(name: string): boolean {
  return /^tenant_t[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(name)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).toSorted().join(",")}]`
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
