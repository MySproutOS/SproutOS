import { randomBytes } from "node:crypto"

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
