import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto"

/**
 * Self-hosted Neon's storage layer, as a client.
 *
 * **The open-source project, not the SaaS.** This talks to a `storage_controller` we run, which
 * talks to pageservers and safekeepers we run. `docker-compose.yaml` brings the whole thing up and
 * `docs/adr/0025` argues why.
 *
 * ## What a "branch" actually is
 *
 * A Neon *tenant* owns a tree of *timelines*. A timeline with an ancestor is a branch: it shares
 * every page its parent had at the branch LSN and stores only what changes afterwards. Creating one
 * copies nothing — a branch of a 100 GB database is a row and an LSN — which is the property
 * `database_branch` was designed around and could not deliver while the provider was `sprout`.
 *
 * ## Ids are Neon's, not ours
 *
 * Tenant and timeline ids are 32 lowercase hex characters. They are not UUIDv7 and not
 * `encodeShortId` output, and the temptation to derive one from a SproutOS uuid should be resisted:
 * Neon generates them elsewhere too — a shard split, an import — and a control plane that assumes it
 * minted every id it sees is one that loses track of the ones it did not.
 */

/** A Neon tenant or timeline id: 128 bits, 32 lowercase hex characters. */
export function neonId(): string {
  return randomBytes(16).toString("hex")
}

export function isNeonId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

export type NeonConfig = {
  /** The storage controller's HTTP address. Every call here goes through it, never to a pageserver. */
  controllerUrl: string
  /** Postgres major version for new timelines. */
  pgVersion: number
}

export function neonConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NeonConfig {
  const controllerUrl = env.NEON_CONTROLLER_URL
  if (controllerUrl === undefined || controllerUrl === "") {
    throw new Error(
      "NEON_CONTROLLER_URL is not set. Every tenant operation goes through the storage " +
        "controller — it is what knows which pageserver holds what — and there is no sensible " +
        "default to fall back to.",
    )
  }

  return {
    controllerUrl: controllerUrl.replace(/\/$/, ""),
    pgVersion: Number(env.NEON_PG_VERSION ?? 16),
  }
}

export class NeonError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`neon ${path}: ${status} ${message}`)
    this.name = "NeonError"
  }
}

async function call<T>(
  config: NeonConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.controllerUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) throw new NeonError(response.status, path, text.slice(0, 400))
  // A 200 with an empty body is normal for the delete endpoints, and `JSON.parse("")` throws.
  return (text === "" ? {} : JSON.parse(text)) as T
}

export type TimelineInfo = {
  tenant_id: string
  timeline_id: string
  ancestor_timeline_id?: string | null
  ancestor_lsn?: string | null
  current_physical_size?: number
}

/**
 * The storage-layer half of a Postgres service.
 *
 * Deliberately not a `ServiceDriver`. A driver has to return a connection URI, and a URI needs a
 * *compute* — a Postgres process started against these pages by `compute_ctl`. That is the next
 * piece, and pretending this is a whole driver would mean a `provision` that reports success and
 * hands back something nothing can connect to. Stating the boundary is better than blurring it:
 * everything here is real and none of it is a database a customer can reach yet.
 */
export function neonStorage(config: NeonConfig) {
  /**
   * Create a tenant: the unit of storage isolation, one per customer database.
   *
   * The controller places it on a pageserver, attaches it, and notifies the control plane — which is
   * `/v1/internal/neon/notify-attach`, and is not optional. See `apps/internal-api/src/v1/neon.ts`.
   */
  async function createTenant(tenantId: string = neonId()): Promise<string> {
    await call(config, "POST", "/v1/tenant", { new_tenant_id: tenantId })
    return tenantId
  }

  /** The tenant's root timeline: the database itself, before any branch. */
  async function createTimeline(
    tenantId: string,
    timelineId: string = neonId(),
  ): Promise<TimelineInfo> {
    return await call<TimelineInfo>(config, "POST", `/v1/tenant/${tenantId}/timeline`, {
      new_timeline_id: timelineId,
      pg_version: config.pgVersion,
    })
  }

  /**
   * Branch a timeline from another, copy-on-write.
   *
   * `ancestor_lsn` omitted means "branch from where the parent is now", which is what a customer
   * asking for a branch means. Passing one is how a point-in-time restore works, and is the same
   * call — worth knowing before someone builds a second mechanism for it.
   */
  async function branchTimeline(
    tenantId: string,
    ancestorTimelineId: string,
    timelineId: string = neonId(),
    ancestorLsn?: string,
  ): Promise<TimelineInfo> {
    return await call<TimelineInfo>(config, "POST", `/v1/tenant/${tenantId}/timeline`, {
      new_timeline_id: timelineId,
      ancestor_timeline_id: ancestorTimelineId,
      pg_version: config.pgVersion,
      ...(ancestorLsn === undefined ? {} : { ancestor_lsn: ancestorLsn }),
    })
  }

  async function deleteTimeline(tenantId: string, timelineId: string): Promise<void> {
    await call(config, "DELETE", `/v1/tenant/${tenantId}/timeline/${timelineId}`)
  }

  async function deleteTenant(tenantId: string): Promise<void> {
    await call(config, "DELETE", `/v1/tenant/${tenantId}`)
  }

  return { branchTimeline, createTenant, createTimeline, deleteTenant, deleteTimeline }
}

/**
 * The spec a compute is started from.
 *
 * `compute_ctl` does not discover anything: it is handed a tenant, a timeline, the pageserver to
 * read pages from, the safekeepers to send WAL to, and the Postgres settings to run with. Building
 * that document *is* the compute half of a control plane, which is why it lives here rather than in
 * a shell script beside the compose file.
 *
 * The shape was arrived at against the real binary, one rejection at a time — `compute_ctl` parses
 * strictly and reports one missing field per attempt, so the fields below are the minimum it
 * accepts and not a superset copied from somewhere.
 */
/**
 * A SCRAM-SHA-256 verifier, in the form Postgres stores in `rolpassword`.
 *
 * **The administrative role needs a password, and finding out why took a diagnostic.** A compute's
 * `pg_hba.conf` trusts `local` and `127.0.0.1/32` and nothing else, so `cloud_admin` with no password
 * works from inside the container and from nowhere else. Every real caller is somewhere else: a
 * proxy reaching a compute over the network, and in development a connection arriving through
 * Docker's published port from the bridge gateway rather than from loopback.
 *
 * The failure is quiet and misleading. TCP connects, Postgres asks for a password, the client has
 * none, and the connection closes — which `psql` reports as "server closed the connection
 * unexpectedly" and a readiness probe reports as "not ready yet", forever. It cost a ninety-second
 * timeout per wake and looked like a slow compute.
 *
 * Format: `SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>`, per
 * RFC 5802. `services/pg-proxy/src/scram.rs` implements the verifying half against RFC 7677's
 * vector; this is the half that produces what it verifies against.
 */
/*
  The salt is derived from the password, not random, and that is a deliberate trade.

  A random salt would make `computeSpec` non-deterministic, and the spec has to be stable for one
  endpoint: two calls that differ only in a salt are two different documents, so every reconcile
  would look like a configuration change and restart a compute that was fine.

  What a salt buys is that one precomputed table cannot attack many accounts at once. Deriving it
  from the password keeps that — two different passwords still get different salts — and gives up
  only the case of two roles sharing a password, where the platform generates the password and does
  not do that.
*/
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = createHash("sha256")
    .update(`sproutos-scram-salt/${password}`)
    .digest()
    .subarray(0, 16)
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256")

  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest()
  const storedKey = createHash("sha256").update(clientKey).digest()
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest()

  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString(
    "base64",
  )}:${serverKey.toString("base64")}`
}

export type ComputeSpecInput = {
  tenantId: string
  timelineId: string
  /** `postgresql://no_user@<pageserver-host>:6400`. */
  pageserverConnstring: string
  /** `<host>:<port>`, no scheme. */
  safekeeperConnstrings: string[]
  /** The port Postgres listens on inside the compute. */
  port?: number
  /** Names a customer's database and role, when the caller has them. */
  clusterId?: string
  /**
   * The tenant's own role and database, created by `compute_ctl` on every start.
   *
   * Declared in the spec rather than created by connecting once at provision time, and that is the
   * difference between a database that can be provisioned in milliseconds and one that cannot: a
   * suspended endpoint has no Postgres to run `create role` against, so anything that required one
   * would mean waking a compute to provision it and waking it again on first use.
   *
   * The role has no password. `pg-proxy` reaches the compute as the administrative role and drops to
   * this one with `SET ROLE` before the session is spliced — the customer's secret authenticates
   * them *to the proxy*, and a password on this role would be a second credential that works
   * against the compute directly.
   */
  role?: string
  database?: string
  /**
   * The password for the administrative role.
   *
   * Required for any caller that is not inside the container — see {@link scramVerifier}. Omitted
   * only in tests that reason about the spec rather than start a compute from it.
   */
  adminPassword?: string
}

/**
 * `neon` in `shared_preload_libraries` is what makes this Postgres read pages from a pageserver
 * instead of a local data directory. Without it the process starts and is an ordinary, empty
 * Postgres — which looks like success.
 */
export function computeSpec(input: ComputeSpecInput): Record<string, unknown> {
  const port = input.port ?? 55433

  const settings = [
    { name: "listen_addresses", value: "0.0.0.0", vartype: "string" },
    { name: "port", value: String(port), vartype: "integer" },
    { name: "shared_preload_libraries", value: "neon", vartype: "string" },
    // `walproposer` is the compute's own WAL sender to the safekeepers. Naming it here is what makes
    // a commit wait for a safekeeper quorum rather than for a local disk.
    { name: "synchronous_standby_names", value: "walproposer", vartype: "string" },
    { name: "wal_level", value: "logical", vartype: "enum" },
    { name: "wal_log_hints", value: "on", vartype: "bool" },
    { name: "hot_standby", value: "on", vartype: "bool" },
    { name: "max_wal_senders", value: "10", vartype: "integer" },
    { name: "max_replication_slots", value: "10", vartype: "integer" },
    { name: "max_connections", value: "100", vartype: "integer" },
    { name: "shared_buffers", value: "1MB", vartype: "string" },
    // Durability is the safekeepers', not this disk's — the local data directory is a cache that is
    // thrown away when the compute stops.
    { name: "fsync", value: "off", vartype: "bool" },
    { name: "restart_after_crash", value: "off", vartype: "bool" },
    { name: "neon.max_cluster_size", value: "1GB", vartype: "string" },
  ]

  return {
    spec: {
      format_version: 1.0,
      timestamp: new Date(0).toISOString(),
      operation_uuid: null,
      cluster: {
        cluster_id: input.clusterId ?? "sproutos",
        name: input.clusterId ?? "sproutos",
        state: "restarted",
        roles: [
          {
            name: "cloud_admin",
            encrypted_password:
              input.adminPassword === undefined ? null : scramVerifier(input.adminPassword),
            options: null,
          },
          ...(input.role === undefined
            ? []
            : [{ name: input.role, encrypted_password: null, options: null }]),
        ],
        databases:
          input.database === undefined || input.role === undefined
            ? []
            : [{ name: input.database, owner: input.role, options: null }],
        settings,
      },
      delta_operations: [],
      tenant_id: input.tenantId,
      timeline_id: input.timelineId,
      mode: "Primary",
      pageserver_connstring: input.pageserverConnstring,
      safekeeper_connstrings: input.safekeeperConnstrings,
      skip_pg_catalog_updates: false,
      // -1 is "never suspend". Scale-to-zero is the proxy's decision, not the compute's, and a
      // compute that suspended itself out from under a live connection would be a worse bug than
      // paying for an idle one.
      suspend_timeout_seconds: -1,
    },
    compute_ctl_config: { jwks: { keys: [] } },
  }
}
