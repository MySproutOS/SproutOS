import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { computeSpec } from "./neon"

const run = promisify(execFile)

/**
 * Waking a suspended endpoint.
 *
 * A timeline is storage: it answers page requests and holds no session and no running query. What a
 * customer connects to is a *compute*, and the economic argument for this whole architecture is
 * that the compute can be absent while the timeline is not. Wake-on-connect is what makes that
 * absence invisible — a connection arrives for an endpoint with nothing running, something starts,
 * and the client's first query answers.
 *
 * ## The control plane starts computes, not the proxy
 *
 * `services/pg-proxy` sits on the tenant's connection path and holds no cloud, Docker or Kubernetes
 * credential — that is the point of it being a data-plane component. So it asks, over HTTP, and
 * this is what answers. A proxy that could create workloads would be a proxy whose compromise
 * creates workloads.
 *
 * ## Two connections, one compute
 *
 * The claim is taken in the database with a conditional update, not held in a process. Two
 * connections arriving at once for the same suspended endpoint must not start two Postgres
 * processes against one timeline: the safekeepers would reject the second one's WAL, but only after
 * it had accepted client connections and told them their transactions committed. The loser of the
 * claim waits for the winner.
 */

export type ComputeAddress = { host: string; port: number }

/**
 * Starting a Postgres against a timeline, however this deployment does that.
 *
 * Docker locally, a pod in a cluster. Behind an interface because the two differ in every detail
 * and in nothing that matters here — the caller needs an address and a handle to stop it by.
 */
export type ComputeLauncher = {
  launch: (input: {
    endpointId: string
    tenantId: string
    timelineId: string
    /** The tenant's role and database, declared in the spec so `compute_ctl` creates them. */
    role?: string
    database?: string
  }) => Promise<{ address: ComputeAddress; runtimeRef: string }>
  stop: (runtimeRef: string) => Promise<void>
  /**
   * Whether the compute is ready for *this tenant*, not merely accepting connections.
   *
   * `database` is the tenant's database when the endpoint declares one. Probing without it is a
   * real bug rather than a shortcut — see the implementation.
   */
  isReady: (address: ComputeAddress, database?: string) => Promise<boolean>
}

export type NeonComputeConfig = {
  image: string
  network: string
  /** How the *compute* reaches the pageserver, which is not how this process reaches it. */
  pageserverConnstring: string
  safekeeperConnstrings: string[]
  /** How the *proxy* reaches the compute. Containers are addressed by name on a shared network. */
  computeHostTemplate: string
  port: number
  /**
   * The administrative password every compute is started with.
   *
   * One password for the whole platform, shared with `pg-proxy`, which is the only thing that uses
   * it. A per-compute password would have to be stored somewhere the proxy can read at connect
   * time, which is a per-connection lookup for a credential that never leaves the platform.
   */
  adminPassword: string
}

export function neonComputeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NeonComputeConfig {
  return {
    /*
      Pinned by digest, not `:latest`.

      The compute image comes from an upstream that has taken eleven commits in twelve months, which
      is why this project forked it. A moving tag on a repository nobody is watching is a change
      nobody decided to make — and this image is the Postgres every customer's data goes through.
    */
    image:
      env.NEON_COMPUTE_IMAGE ??
      "neondatabase/compute-node-v16@sha256:b3e151661bd2ee11eb2843c8926001966cb23969227e9673c5f42fc3fbe14249",
    network: env.NEON_COMPUTE_NETWORK ?? "sproutos_default",
    pageserverConnstring:
      env.NEON_PAGESERVER_CONNSTRING ?? "postgresql://no_user@neon-pageserver:6400",
    safekeeperConnstrings: (env.NEON_SAFEKEEPER_CONNSTRINGS ?? "neon-safekeeper:5454").split(","),
    computeHostTemplate: env.NEON_COMPUTE_HOST_TEMPLATE ?? "neon-compute-{id}",
    port: Number(env.NEON_COMPUTE_PORT ?? 55433),
    adminPassword: env.NEON_COMPUTE_ADMIN_PASSWORD ?? "",
  }
}

/**
 * Computes as Docker containers, for development.
 *
 * The production launcher is a pod, and the shape of this one is chosen so that swap is not a
 * rewrite: a name derived from the endpoint, a spec passed in, an address out.
 */
export function dockerComputeLauncher(config: NeonComputeConfig): ComputeLauncher {
  function containerName(endpointId: string): string {
    return config.computeHostTemplate.replace("{id}", endpointId.replaceAll("-", "").slice(-12))
  }

  /**
   * A host port derived from the endpoint, not an ephemeral one.
   *
   * **Ephemeral ports are recycled, and that is a correctness bug rather than an inconvenience.**
   * `neon_endpoint` stores the address of a running compute and the warm path trusts it without
   * probing — deliberately, so a connection to a warm database costs one indexed read. If the port
   * is ephemeral, a compute that stops frees its port, Docker hands the same number to the next
   * container, and a stale `running` row now addresses **another tenant's Postgres**. It surfaced as
   * `database "sprout_db_…" does not exist`: the proxy connected successfully, to the wrong compute.
   *
   * Deriving the port from the endpoint id means a recycled port always belongs to the same
   * endpoint, so the worst case becomes "connect to my own restarted compute" instead of "connect to
   * somebody else's". `launch` removes any container of this name first, so a collision with our own
   * stale container resolves itself.
   *
   * Development only. In a cluster the address is the pod's IP and the pod dies with the row.
   */
  function hostPort(endpointId: string): number {
    // The template is in the hash as well as the endpoint id, so two launchers configured with
    // different container-name prefixes — two test files, or a developer running beside CI — cannot
    // derive the same port for different endpoints.
    const digest = createHash("sha256")
      .update(`${config.computeHostTemplate}/${endpointId}`)
      .digest()
    // 20000 ports starting at 30000: above the ephemeral range on Linux (32768+ is common, but the
    // published port is chosen by us here, so what matters is staying out of well-known ports and
    // out of the ports this repository's compose file already uses).
    return 30_000 + (digest.readUInt32BE(0) % 20_000)
  }

  return {
    launch: async ({ endpointId, tenantId, timelineId, role, database }) => {
      const name = containerName(endpointId)
      // Removed first, not "created if absent": a container left behind by a crashed wake is in an
      // unknown state, and reusing it would attach a second Postgres to a timeline.
      await run("docker", ["rm", "-f", name]).catch(() => undefined)

      const spec = computeSpec({
        tenantId,
        timelineId,
        pageserverConnstring: config.pageserverConnstring,
        safekeeperConnstrings: config.safekeeperConnstrings,
        port: config.port,
        clusterId: endpointId,
        ...(role === undefined ? {} : { role }),
        ...(database === undefined ? {} : { database }),
        ...(config.adminPassword === "" ? {} : { adminPassword: config.adminPassword }),
      })

      /*
        The spec goes in on stdin of a `sh -c`, not through a mounted file.

        A file would mean a directory this process and the container both have to see, which is true
        on a laptop and false everywhere else — the control plane and the compute do not share a
        filesystem in a cluster. Writing it inside the container is the shape that survives the move
        to a pod, where it becomes a projected volume rather than a bind mount.
      */
      const script =
        `cat > /tmp/spec.json <<'SPEC'\n${JSON.stringify(spec)}\nSPEC\n` +
        `exec /usr/local/bin/compute_ctl -D /var/db/postgres/compute ` +
        `-C "postgresql://cloud_admin@localhost:${config.port}/postgres" ` +
        `-b /usr/local/bin/postgres -c /tmp/spec.json -i ${endpointId} --dev`

      const { stdout } = await run("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--network",
        config.network,
        /*
          Published on an ephemeral loopback port, and this is the whole reason the launcher returns
          an address rather than a name.

          A container name resolves inside `config.network` and nowhere else. In development
          `pg-proxy` runs on the host, so an address of `neon-compute-abc:55433` is a name it cannot
          look up — the connection fails with "server closed the connection unexpectedly", which
          says nothing about DNS. In a cluster the launcher is a pod and the address is its IP,
          reachable from the proxy directly; that is the same shape, resolved differently.
        */
        "-p",
        `127.0.0.1:${hostPort(endpointId)}:${config.port}`,
        "--entrypoint",
        "/bin/sh",
        config.image,
        "-c",
        script,
      ])

      return {
        address: { host: "127.0.0.1", port: hostPort(endpointId) },
        runtimeRef: stdout.trim(),
      }
    },

    stop: async (runtimeRef) => {
      await run("docker", ["rm", "-f", runtimeRef]).catch(() => undefined)
    },

    /*
      Readiness is a query **against the tenant's own database**, not a port check and not a query
      against `postgres`.

      `compute_ctl` starts Postgres and *then* applies the spec — `CreateAndAlterRoles`,
      `CreateAndAlterDatabases`, `CreateSchemaNeon`. So there is a window in which the port accepts
      connections, `select 1` on `postgres` succeeds, and the tenant's database does not exist yet.

      Probing `postgres` reports ready during that window. On an idle machine the window is a few
      milliseconds and everything appears to work; under load it widens, the proxy is handed an
      address, and the client gets `database "sprout_db_…" does not exist` — a failure that reads
      like a provisioning bug and is really a readiness bug. It cost an afternoon.
    */
    isReady: async (address, database) => {
      // Probed from outside, on the address the caller was given. Probing with `docker exec` inside
      // the container would say the compute is ready while the published port is not yet
      // forwarding, which is a difference the proxy would discover instead.
      /*
        Both timeouts are load-bearing, and their absence is why this hung rather than failed.

        `connect_timeout` bounds the TCP connect: Docker publishes the port the instant the
        container starts, so the port accepts a connection long before Postgres answers on it, and
        `psql` with no timeout waits indefinitely on a socket nobody is reading.

        The `timeout` on the process bounds everything else — a `psql` that connects and then blocks
        on the startup packet is not covered by `connect_timeout` at all.
      */
      const probe = await run(
        "psql",
        [
          // The password matters here as much as the timeouts. A compute's `pg_hba.conf` trusts
          // `127.0.0.1/32` *inside the container*, and a connection through Docker's published port
          // arrives from the bridge gateway — so without it Postgres asks for a password, the probe
          // fails, and the wake reports "not ready" until it times out.
          `postgresql://cloud_admin:${encodeURIComponent(config.adminPassword)}@${address.host}:${address.port}/${database ?? "postgres"}?connect_timeout=3`,
          "-tAc",
          "select 1",
        ],
        { timeout: 5_000 },
      ).catch(() => undefined)

      return probe?.stdout.trim() === "1"
    },
  }
}

/** How long a wake may take before the caller is told to give up. */
export const WAKE_TIMEOUT_MS = 90_000

export class WakeTimeoutError extends Error {
  constructor(endpointId: string) {
    super(`compute for endpoint ${endpointId} did not become ready in time`)
    this.name = "WakeTimeoutError"
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ensure a compute is running for an endpoint, and return where it answers.
 *
 * Idempotent by design: called on every connection, and on all but the first it is one indexed read.
 */
export async function wakeEndpoint(
  db: Kysely<DB>,
  launcher: ComputeLauncher,
  endpointId: string,
  now: () => number = Date.now,
): Promise<ComputeAddress> {
  const deadline = now() + WAKE_TIMEOUT_MS

  for (;;) {
    const endpoint = await db
      .selectFrom("neonEndpoint")
      .select([
        "id",
        "state",
        "host",
        "port",
        "tenantId",
        "timelineId",
        "runtimeRef",
        "roleName",
        "databaseName",
      ])
      .where("id", "=", endpointId)
      .executeTakeFirst()

    if (endpoint === undefined) throw new Error(`no such endpoint ${endpointId}`)

    if (endpoint.state === "running" && endpoint.host !== null && endpoint.port !== null) {
      const address = { host: endpoint.host, port: endpoint.port }
      /*
        Trusted without probing, deliberately.

        Probing here would put a round trip on every connection to a warm endpoint, which is the
        common case and the one that has to be fast. A compute that died leaves a row saying
        `running`, and the connection then fails — which the proxy reports, and which the reaper
        corrects. Being wrong occasionally on the rare path beats being slow always on the common
        one.
      */
      return address
    }

    if (endpoint.state === "starting") {
      // Somebody else is starting it. Wait for them rather than racing: two computes against one
      // timeline is two Postgres processes writing the same pages.
      if (now() > deadline) throw new WakeTimeoutError(endpointId)
      await sleep(250)
      continue
    }

    // Claim the start. Conditional on the state we just read, so of two connections arriving
    // together exactly one gets the claim and the other falls into the branch above.
    const claimed = await db
      .updateTable("neonEndpoint")
      .set({ state: "starting", updatedAt: new Date() })
      .where("id", "=", endpointId)
      .where("state", "in", ["suspended", "error"])
      .returning("id")
      .executeTakeFirst()

    if (claimed === undefined) continue

    try {
      const { address, runtimeRef } = await launcher.launch({
        endpointId,
        tenantId: endpoint.tenantId,
        timelineId: endpoint.timelineId,
        ...(endpoint.roleName === null ? {} : { role: endpoint.roleName }),
        ...(endpoint.databaseName === null ? {} : { database: endpoint.databaseName }),
      })

      while (now() < deadline) {
        // The tenant's database, when the endpoint has one. See `isReady`.
        if (await launcher.isReady(address, endpoint.databaseName ?? undefined)) {
          await db
            .updateTable("neonEndpoint")
            .set({
              state: "running",
              host: address.host,
              port: address.port,
              runtimeRef,
              startedAt: new Date(),
              suspendedAt: null,
              updatedAt: new Date(),
            })
            .where("id", "=", endpointId)
            .execute()

          return address
        }
        await sleep(500)
      }

      // Timed out coming up. The container is removed rather than left running: a compute nothing
      // knows the address of still holds the timeline against a future wake.
      await launcher.stop(runtimeRef).catch(() => undefined)
      throw new WakeTimeoutError(endpointId)
    } catch (error) {
      await db
        .updateTable("neonEndpoint")
        .set({ state: "error", updatedAt: new Date() })
        .where("id", "=", endpointId)
        .execute()
      throw error
    }
  }
}

/**
 * Stop a compute and mark the endpoint suspended.
 *
 * The timeline is untouched — that is the entire point. Everything the customer's database *is*
 * lives in the pageserver, and this releases the only part that costs money while idle.
 */
export async function suspendEndpoint(
  db: Kysely<DB>,
  launcher: ComputeLauncher,
  endpointId: string,
): Promise<void> {
  const endpoint = await db
    .selectFrom("neonEndpoint")
    .select(["runtimeRef"])
    .where("id", "=", endpointId)
    .executeTakeFirst()

  if (endpoint?.runtimeRef != null) await launcher.stop(endpoint.runtimeRef)

  await db
    .updateTable("neonEndpoint")
    .set({
      state: "suspended",
      host: null,
      port: null,
      runtimeRef: null,
      suspendedAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", endpointId)
    .execute()
}

/** Register an endpoint for a timeline, suspended. Nothing starts until something connects. */
export async function createEndpoint(
  db: Kysely<DB>,
  input: {
    backendServiceId: string
    databaseBranchId?: string | null
    tenantId: string
    timelineId: string
    roleName?: string | null
    databaseName?: string | null
  },
): Promise<string> {
  const id = v7()
  await db
    .insertInto("neonEndpoint")
    .values({
      id,
      backendServiceId: input.backendServiceId,
      databaseBranchId: input.databaseBranchId ?? null,
      tenantId: input.tenantId,
      timelineId: input.timelineId,
      roleName: input.roleName ?? null,
      databaseName: input.databaseName ?? null,
      state: "suspended",
    })
    .execute()

  return id
}
