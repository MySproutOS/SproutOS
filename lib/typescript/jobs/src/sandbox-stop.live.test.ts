import { Daytona } from "@daytona/sdk"
import { crudSandbox } from "@lib/dao"
import {
  daytonaConfigFromEnv,
  daytonaClientFromEnv,
  SNAPSHOT_RESOURCES,
  type CreateSandboxInput,
  type DaytonaConfig,
  type DaytonaSandboxClient,
} from "@lib/sandbox"
import { buildCreateParams, daytonaProxyCredential } from "@lib/sandbox/daytona"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { reapSandboxes, SANDBOX_KINDS, stopSandbox } from "./sandbox"

try {
  process.loadEnvFile()
} catch {
  // CI may supply variables directly, and a checkout may intentionally have no .env.
}

let driver: DaytonaSandboxClient | undefined
let daytonaConfig: DaytonaConfig | undefined
try {
  daytonaConfig = daytonaConfigFromEnv()
  driver = daytonaClientFromEnv()
} catch {
  driver = undefined
}

async function createSandbox(input: CreateSandboxInput): Promise<{ externalId: string }> {
  if (driver === undefined || daytonaConfig === undefined) throw new Error("Daytona is unavailable")
  const localProxy = process.env.SANDBOX_LIVE_FORWARD_PROXY_URL
  if (localProxy === undefined) return await driver.create(input)
  if (!egressControlPlaneReady) {
    throw new Error("SANDBOX_LIVE_FORWARD_PROXY_URL requires the gated egress control-plane test")
  }

  const proxy = new URL(localProxy)
  if (proxy.protocol !== "http:" || proxy.username !== "" || proxy.password !== "") {
    throw new Error("the local live-test proxy must be an unauthenticated HTTP origin")
  }
  proxy.username = input.sandboxId.toLowerCase()
  proxy.password = daytonaProxyCredential(daytonaConfig.forwardProxyRootKey, input)

  const sdk = new Daytona({
    apiKey: daytonaConfig.apiKey,
    organizationId: daytonaConfig.organizationId,
    ...(daytonaConfig.apiUrl ? { apiUrl: daytonaConfig.apiUrl } : {}),
    ...(daytonaConfig.target ? { target: daytonaConfig.target } : {}),
  })
  const made = await sdk.create({
    ...buildCreateParams(daytonaConfig, input),
    outboundProxyUrl: proxy.toString(),
  })
  return { externalId: made.id }
}

let reachable = false
let userId: string
let organizationId: string
let repositoryId: string
let projectId: string
const sandboxes: string[] = []
const egressControlPlaneReady = process.env.SANDBOX_LIVE_EGRESS_CONTROL_PLANE === "1"

beforeAll(async () => {
  if (driver === undefined) return
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  userId = v7()
  organizationId = v7()
  repositoryId = v7()
  projectId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `reap-${userId}@test.invalid`, name: "Reap Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Reap Test Org",
      slug: `reap-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "reap-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({ id: projectId, organizationId, repositoryId, name: "Reap", slug: "reap-test" })
    .execute()
}, 120_000)

afterAll(async () => {
  if (driver !== undefined) {
    for (const id of sandboxes) await driver.destroy(id).catch(() => {})
  }
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await sql`delete from metering_outbox where payload ->> 'organization_id' = ${organizationId}`.execute(
      tx,
    )
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
}, 120_000)

describe("an idle sandbox is actually turned off", () => {
  it("routes arbitrary HTTPS through the proxy while blocking bypass and metadata", async ({
    skip,
  }) => {
    if (!reachable || driver === undefined || !egressControlPlaneReady) skip()
    const activeDriver = driver!
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: null,
      provider: "daytona",
      state: "starting",
      idleTimeoutS: 900,
    })
    let externalId: string | undefined
    try {
      const made = await createSandbox({
        sandboxId: sandbox.id,
        organizationId,
        projectId,
        userId,
        sandboxClass: "container",
        alwaysOn: false,
        resources: SNAPSHOT_RESOURCES,
        idleTimeoutS: 900,
      })
      externalId = made.externalId
      await crudSandbox(db).update(sandbox.id, {
        externalId: made.externalId,
        state: "running",
      })

      // The test is gated because its proxy must authorize against the same database that owns
      // this row. The local harness starts that proxy and gives Daytona a one-run ngrok endpoint;
      // production points the same test at the deployed HTTPS listener.
      const publicThroughProxy = await activeDriver.exec(
        made.externalId,
        ["curl", "--fail", "--show-error", "https://www.google.com/generate_204"],
        30_000,
      )
      if (publicThroughProxy.exitCode !== 0) {
        throw new Error(
          `public HTTPS through the proxy failed: ${JSON.stringify(publicThroughProxy)}`,
        )
      }
      const postgresThroughProxy = await activeDriver.exec(
        made.externalId,
        [
          "node",
          "-e",
          [
            "const proxy = new URL(process.env.HTTPS_PROXY)",
            "const transport = await import(proxy.protocol === 'https:' ? 'node:https' : 'node:http')",
            "const credentials = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64')",
            "const request = transport.request({ host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), method: 'CONNECT', path: 'postgres.sproutos.me:5432', headers: { 'Proxy-Authorization': 'Basic ' + credentials } })",
            "request.on('connect', (response, socket) => {",
            "  console.log(response.statusCode)",
            "  if (response.statusCode !== 200) { socket.destroy(); process.exit(1); return }",
            "  const sslRequest = Buffer.alloc(8)",
            "  sslRequest.writeInt32BE(8, 0)",
            "  sslRequest.writeInt32BE(80877103, 4)",
            "  socket.once('data', (chunk) => { console.log(String.fromCharCode(chunk[0])); socket.destroy(); process.exit(chunk[0] === 83 ? 0 : 1) })",
            "  socket.write(sslRequest)",
            "})",
            "request.on('error', (error) => { console.error(error.message); process.exit(1) })",
            "request.end()",
          ].join(";"),
        ],
        15_000,
      )
      // CONNECT 200 alone proved only that the proxy accepted the request. `S` is the first real
      // Postgres protocol response to an SSLRequest, so bytes crossed the resulting tunnel too.
      // No database credential is needed for this transport seam.
      expect(postgresThroughProxy).toMatchObject({ exitCode: 0, stdout: "200\nS\n" })
      const directBypass = await activeDriver.exec(
        made.externalId,
        [
          "curl",
          "--noproxy",
          "*",
          "--connect-timeout",
          "5",
          "--fail",
          "--silent",
          "https://www.google.com/generate_204",
        ],
        15_000,
      )
      expect(directBypass.exitCode).not.toBe(0)
      const metadata = await activeDriver.exec(
        made.externalId,
        [
          "curl",
          "--connect-timeout",
          "5",
          "--fail",
          "--silent",
          "http://169.254.169.254/latest/meta-data/",
        ],
        15_000,
      )
      expect(metadata.exitCode).not.toBe(0)
      await activeDriver.cloneRepository(made.externalId, {
        url: "https://github.com/octocat/Hello-World.git",
        path: `${activeDriver.workspaceDir}/egress-clone`,
        branch: "master",
        username: "",
        password: "",
        depth: 1,
      })
      expect(
        (
          await activeDriver.readFile(
            made.externalId,
            `${activeDriver.workspaceDir}/egress-clone/README`,
          )
        ).length,
      ).toBeGreaterThan(0)
    } finally {
      if (externalId !== undefined) await activeDriver.destroy(externalId).catch(() => {})
      await crudSandbox(db).remove(sandbox.id)
    }
  }, 600_000)

  it("stops Daytona at the provider, and meters the time before it does", async ({ skip }) => {
    if (!reachable || driver === undefined) skip()
    const activeDriver = driver!
    const lastActivityAt = new Date(Date.now() - 20 * 60_000)
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: null,
      provider: "daytona",
      state: "starting",
      idleTimeoutS: 900,
      lastActivityAt,
      meteredThrough: lastActivityAt,
    })
    const made = await activeDriver.create({
      sandboxId: sandbox.id,
      organizationId,
      projectId,
      userId,
      sandboxClass: "container",
      alwaysOn: false,
      resources: SNAPSHOT_RESOURCES,
      idleTimeoutS: 900,
    })
    sandboxes.push(made.externalId)
    await crudSandbox(db).update(sandbox.id, { externalId: made.externalId, state: "running" })
    expect(await activeDriver.state(made.externalId)).toBe("started")

    await reapSandboxes(
      { id: v7(), kind: SANDBOX_KINDS.reap, payload: {} } as never,
      { db } as never,
    )

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["id", "payload"])
      .where("kind", "=", SANDBOX_KINDS.stop)
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirstOrThrow()
    expect((queued.payload as { sandboxId?: string }).sandboxId).toBe(sandbox.id)

    await stopSandbox(() => activeDriver)(
      { id: queued.id, kind: SANDBOX_KINDS.stop, payload: queued.payload } as never,
      { db } as never,
    )

    expect(await activeDriver.state(made.externalId)).toBe("stopped")
    const row = await db
      .selectFrom("sandbox")
      .select(["state", "meteredThrough"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("stopped")
    expect(row.meteredThrough).not.toBeNull()

    const usage = await sql<{ payload: string }>`
      select payload::text as payload
      from metering_outbox
      where payload ->> 'organization_id' = ${organizationId}
    `.execute(db)
    expect(usage.rows.length).toBeGreaterThan(0)
  }, 600_000)
})
