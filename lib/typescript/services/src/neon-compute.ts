import { execFile } from "node:child_process"
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
  }) => Promise<{ address: ComputeAddress; runtimeRef: string }>
  stop: (runtimeRef: string) => Promise<void>
  /** Whether the compute is accepting connections yet. */
  isReady: (address: ComputeAddress) => Promise<boolean>
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
}

export function neonComputeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NeonComputeConfig {
  return {
    image: env.NEON_COMPUTE_IMAGE ?? "neondatabase/compute-node-v16:latest",
    network: env.NEON_COMPUTE_NETWORK ?? "sproutos_default",
    pageserverConnstring:
      env.NEON_PAGESERVER_CONNSTRING ?? "postgresql://no_user@neon-pageserver:6400",
    safekeeperConnstrings: (env.NEON_SAFEKEEPER_CONNSTRINGS ?? "neon-safekeeper:5454").split(","),
    computeHostTemplate: env.NEON_COMPUTE_HOST_TEMPLATE ?? "neon-compute-{id}",
    port: Number(env.NEON_COMPUTE_PORT ?? 55433),
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

  return {
    launch: async ({ endpointId, tenantId, timelineId }) => {
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
        "--entrypoint",
        "/bin/sh",
        config.image,
        "-c",
        script,
      ])

      return {
        address: { host: name, port: config.port },
        runtimeRef: stdout.trim(),
      }
    },

    stop: async (runtimeRef) => {
      await run("docker", ["rm", "-f", runtimeRef]).catch(() => undefined)
    },

    /*
      Readiness is a query, not a port check.

      `compute_ctl` binds before Postgres finishes applying the spec — creating roles, the neon
      schema, the extension — so a port that accepts a connection is not a database that answers
      one. A proxy handed an address at that moment splices a client into a connection that fails.
    */
    isReady: async (address) => {
      const probe = await run("docker", [
        "exec",
        address.host,
        "psql",
        `postgresql://cloud_admin@localhost:${address.port}/postgres`,
        "-tAc",
        "select 1",
      ]).catch(() => undefined)

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
      .select(["id", "state", "host", "port", "tenantId", "timelineId", "runtimeRef"])
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
      })

      while (now() < deadline) {
        if (await launcher.isReady(address)) {
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
      state: "suspended",
    })
    .execute()

  return id
}
