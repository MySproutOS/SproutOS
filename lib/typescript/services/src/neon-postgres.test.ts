import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { neonConfigFromEnv } from "./neon"
import { dockerComputeLauncher, neonComputeConfigFromEnv } from "./neon-compute"
import { neonPostgresDriver, neonPostgresConfigFromEnv } from "./neon-postgres"

/**
 * A Neon-backed database, reached the way a customer reaches one.
 *
 * The whole path in one test: provision creates a tenant and a timeline and **starts nothing**, the
 * customer receives a connection string, `pg-proxy` authenticates them against
 * `service_credential`, asks the control plane to wake a compute, and splices the session. The first
 * query answers against a Postgres that did not exist when the connection was opened.
 *
 * This is what the OAuth provider's per-user database provisioning was descoped waiting for. A
 * hundred thousand of these are a hundred thousand rows and a hundred thousand timelines, costing
 * storage and no compute; on `sprout` they are a hundred thousand idle databases on a cluster
 * somebody pays for.
 */
const run = promisify(execFile)

const neon = (() => {
  try {
    return neonConfigFromEnv()
  } catch {
    return undefined
  }
})()

const proxyBinary = new URL("../../../../target/debug/pg-proxy", import.meta.url).pathname
const apiPort = 3099
const proxyPort = 25433

const reachable = await (async () => {
  if (neon === undefined) return false
  try {
    const response = await fetch(`${neon.controllerUrl}/control/v1/node`)
    if (!response.ok) return false
    await run("docker", ["version"])
    const { existsSync } = await import("node:fs")
    return existsSync(proxyBinary)
  } catch {
    return false
  }
})()

let proxy: ChildProcess | undefined
let api: ChildProcess | undefined
const proxyLog: string[] = []

/** Run `psql`, and put the proxy's explanation in the failure when it refuses. */
async function psql(uri: string, sql: string): Promise<string> {
  const before = proxyLog.length
  try {
    const { stdout } = await run("psql", [uri, "-tAc", sql], { timeout: 120_000 })
    return stdout
  } catch (cause) {
    const explanation = proxyLog.slice(before).join("").trim()
    // The endpoint row too: "database does not exist" from the backend means the compute came up
    // without the tenant's database, and what the spec was built from is the only way to tell why.
    const rows = await db
      .selectFrom("neonEndpoint")
      .select(["id", "state", "host", "port", "roleName", "databaseName", "timelineId"])
      .execute()
    throw new Error(
      `${(cause as Error).message}\n--- pg-proxy said ---\n${explanation || "(nothing)"}` +
        `\n--- endpoints ---\n${JSON.stringify(rows, null, 1)}`, { cause: cause },
    )
  }
}
const created: { services: string[]; tenants: string[] } = { services: [], tenants: [] }
let organizationId = ""
let userId = ""

/*
  Its own container-name prefix, and therefore its own derived port range.

  `neon-compute.test.ts` runs in parallel with this file and drives the same launcher. Sharing a
  prefix means sharing a namespace of container names and host ports between two suites that start
  and stop computes independently.
*/
const launcher = reachable
  ? dockerComputeLauncher({
      ...neonComputeConfigFromEnv(),
      computeHostTemplate: "neon-pgtest-{id}",
    })
  : undefined

function driver() {
  return neonPostgresDriver(
    db,
    { ...neonPostgresConfigFromEnv(), publicHost: "127.0.0.1", publicPort: proxyPort },
    launcher!,
  )
}

beforeAll(async () => {
  if (!reachable) return

  userId = v7()
  organizationId = v7()
  await db
    .insertInto("user")
    .values({ id: userId, email: `np-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "NP",
      slug: `np-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()

  /*
    A minimal control plane: the one route `pg-proxy` calls.

    The real `apps/internal-api` would do, and starting it here would drag its whole boot — Stripe,
    GitHub, KMS — into a test about a database connection. What is under test is the *contract*
    between the proxy and the control plane, and this serves exactly it, using the same
    `wakeEndpoint` the real route uses.
  */
  const { createServer } = await import("node:http")
  const { wakeEndpoint } = await import("./neon-compute")

  api = undefined
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on("end", () => {
      void (async () => {
        try {
          const { backend_service_id } = JSON.parse(body) as { backend_service_id: string }
          const endpoint = await db
            .selectFrom("neonEndpoint")
            .select("id")
            .where("backendServiceId", "=", backend_service_id)
            .executeTakeFirst()

          if (endpoint === undefined) {
            response.writeHead(404).end("{}")
            return
          }

          const address = await wakeEndpoint(db, launcher!, endpoint.id)
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(JSON.stringify(address))
        } catch {
          response.writeHead(503).end("{}")
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(apiPort, "127.0.0.1", resolve))
  ;(globalThis as { __wakeServer?: unknown }).__wakeServer = server

  proxy = spawn(proxyBinary, [], {
    env: {
      ...process.env,
      PG_PROXY_LISTEN: `127.0.0.1:${proxyPort}`,
      PG_PROXY_WAKE_URL: `http://127.0.0.1:${apiPort}/wake`,
      // The compute is the backend now, so the shared-cluster fallback is never used — but the
      // proxy still needs a valid configuration to start, and giving it a real one means a bug in
      // the wake path shows up as "connected to the wrong database" rather than "failed to boot".
      PG_PROXY_BACKEND_HOST: "127.0.0.1",
      PG_PROXY_BACKEND_PORT: "25281",
      PG_PROXY_BACKEND_USER: "cloud_admin",
      // The compute's administrative password. `pg_hba` inside a compute trusts loopback only, so
      // the proxy — which is not loopback — authenticates like any other network client.
      PG_PROXY_BACKEND_PASSWORD: process.env.NEON_COMPUTE_ADMIN_PASSWORD ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  /*
    The proxy's own log, kept and printed when a connection fails.

    Without it a refused connection is only ever "server closed the connection unexpectedly" from
    `psql`, which is what the client sees and says nothing about why — the reason is always in the
    proxy, one process away.
  */
  const collect = (chunk: Buffer) => proxyLog.push(chunk.toString())
  proxy.stdout?.on("data", collect)
  proxy.stderr?.on("data", collect)

  let exited: string | undefined
  proxy.on("exit", (code) => {
    exited = `pg-proxy exited with ${code} before becoming ready`
  })

  const deadline = Date.now() + 20_000
  for (;;) {
    if (exited !== undefined) throw new Error(exited)
    if (Date.now() > deadline) throw new Error("pg-proxy did not start")
    const probe = await run("nc", ["-z", "127.0.0.1", String(proxyPort)]).catch(() => undefined)
    if (probe !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}, 120_000)

afterAll(async () => {
  proxy?.kill("SIGTERM")
  const server = (globalThis as { __wakeServer?: { close: (cb: () => void) => void } }).__wakeServer
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  api?.kill("SIGTERM")
  if (!reachable) return

  for (const id of created.services)
    await driver()
      .destroy(id)
      .catch(() => undefined)
  if (created.services.length > 0) {
    await db.deleteFrom("neonEndpoint").where("backendServiceId", "in", created.services).execute()
    await db.deleteFrom("backendService").where("id", "in", created.services).execute()
  }
  if (organizationId !== "") {
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  }
  await db.destroy()
}, 300_000)

async function service() {
  const backendServiceId = v7()
  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "Neon Postgres",
      kind: "postgres",
      status: "provisioning",
    })
    .execute()
  created.services.push(backendServiceId)

  return backendServiceId
}

describe.runIf(reachable)("a Neon-backed database", () => {
  it("provisions without starting anything", async () => {
    /*
      Not a half-provisioned state to be finished later — the finished state. The customer has a
      working connection string for a database with no process behind it, and that is the property
      that makes a hundred thousand of them affordable.
    */
    const backendServiceId = await service()

    const provisioned = await driver().provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Neon Postgres",
    })

    expect(provisioned.connectionUri.startsWith("postgresql://")).toBe(true)

    const endpoint = await db
      .selectFrom("neonEndpoint")
      .select(["state", "host", "tenantId"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    expect(endpoint.state).toBe("suspended")
    expect(endpoint.host).toBeNull()
    created.tenants.push(endpoint.tenantId)

    const instance = await db
      .selectFrom("databaseInstance")
      .select(["provider", "providerProjectId"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    // The column has allowed `neon` since the first migration and nothing ever wrote it.
    expect(instance.provider).toBe("neon")
    expect(instance.providerProjectId).toBe(endpoint.tenantId)
  }, 300_000)

  it("answers a query on the connection string it handed out", async () => {
    /*
      The whole path. `psql` authenticates to `pg-proxy` with the customer's secret, the proxy asks
      the control plane to wake a compute, and the query runs against a Postgres that did not exist
      when the connection was opened.
    */
    const backendServiceId = await service()
    const provisioned = await driver().provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Neon Postgres",
    })

    expect((await psql(provisioned.connectionUri, "select 1 + 1")).trim()).toBe("2")
  }, 300_000)

  it("keeps what was written across a suspend", async () => {
    // The compute goes and the database does not, which is the only reason scale-to-zero is
    // acceptable rather than merely cheap.
    const backendServiceId = await service()
    const provisioned = await driver().provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Neon Postgres",
    })

    await run(
      "psql",
      [provisioned.connectionUri, "-tAc", "create table t(v text); insert into t values ('kept')"],
      { timeout: 120_000 },
    )

    await driver().suspend(backendServiceId)
    // Suspension refuses new connections as well as stopping the compute; resuming is what lets the
    // next connection wake it again.
    await driver().resume?.(backendServiceId)

    expect((await psql(provisioned.connectionUri, "select v from t")).trim()).toBe("kept")
  }, 600_000)
})
