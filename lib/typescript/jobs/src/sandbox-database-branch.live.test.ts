import { seal } from "@lib/envelope"
import {
  daytonaConfigFromEnv,
  daytonaClientFromEnv,
  SNAPSHOT_RESOURCES,
  type DaytonaSandboxClient,
} from "@lib/sandbox"
import { buildCreateParams } from "@lib/sandbox/daytona"
import {
  createDevBranch,
  dropDevBranch,
  MAX_SANDBOX_DATABASE_BRANCHES,
  neonApi,
  neonApiConfigFromEnv,
  neonPostgresConfigFromEnv,
  parseNeonUri,
  rolePasswordContext,
} from "@lib/services"
import { db } from "@sproutos/db"
import { Daytona } from "@daytona/sdk"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { renderSproutosSkill } from "@lib/agent/skill"
import { runSandboxTurn } from "@lib/agent/sandbox-agent"
import {
  SANDBOX_NETWORK_LAUNCHER,
  SANDBOX_NETWORK_LAUNCHER_SOURCE,
} from "@lib/agent/sandbox-network"

const actionPublicUrl = process.env.SANDBOX_DATABASE_BRANCH_ACTION_URL
const pgPublicUrl = process.env.SANDBOX_DATABASE_BRANCH_PG_URL
const openaiKey = process.env.OPENAI_KEY
const enabled =
  actionPublicUrl !== undefined && pgPublicUrl !== undefined && openaiKey !== undefined

let driver: DaytonaSandboxClient | undefined
try {
  driver = daytonaClientFromEnv()
} catch {
  driver = undefined
}

const ids = {
  backendService: v7(),
  databaseInstance: v7(),
  organization: v7(),
  primaryBranch: v7(),
  project: v7(),
  repository: v7(),
  sandbox: v7(),
  user: v7(),
}
const providerProjects: string[] = []
const providerSandboxes: string[] = []

afterAll(async () => {
  if (!enabled) return
  if (driver !== undefined) {
    for (const id of providerSandboxes) await driver.destroy(id).catch(() => undefined)
  }
  const neon = neonApiConfigFromEnv()
  for (const id of providerProjects) {
    await neonApi(neon)
      .deleteProject(id)
      .catch(() => undefined)
  }
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("serviceCredential")
      .where("backendServiceId", "=", ids.backendService)
      .execute()
    await tx.deleteFrom("sandbox").where("id", "=", ids.sandbox).execute()
    await tx.deleteFrom("databaseRole").where("databaseBranchId", "=", ids.primaryBranch).execute()
    await tx
      .deleteFrom("databaseBranch")
      .where("databaseInstanceId", "=", ids.databaseInstance)
      .execute()
    await tx.deleteFrom("databaseInstance").where("id", "=", ids.databaseInstance).execute()
    await tx.deleteFrom("backendService").where("id", "=", ids.backendService).execute()
    await tx.deleteFrom("project").where("id", "=", ids.project).execute()
    await tx.deleteFrom("repository").where("id", "=", ids.repository).execute()
    await tx.deleteFrom("organization").where("id", "=", ids.organization).execute()
    await tx.deleteFrom("user").where("id", "=", ids.user).execute()
  })
  await db.destroy()
}, 300_000)

describe.skipIf(!enabled || driver === undefined)(
  "a real agent using the sandbox database skill",
  () => {
    it("notices the skill, creates a branch, connects through pg-proxy, and deletes it", async () => {
      const activeDriver = driver!
      const neonConfig = neonApiConfigFromEnv()
      const pgEndpoint = new URL(pgPublicUrl!)
      const postgresConfig = {
        ...neonPostgresConfigFromEnv(),
        publicHost: pgEndpoint.hostname,
        publicPort: Number(pgEndpoint.port),
        sslmode: "disable",
      }
      const api = neonApi(neonConfig)
      const {
        project: providerProject,
        branch: providerBranch,
        connectionUri,
      } = await api.createProject({ name: `sproutos-agent-branch-${Date.now()}`, maxCu: 1 })
      providerProjects.push(providerProject.id)
      const neon = parseNeonUri(connectionUri)
      const roleId = v7()
      const sealed = await seal(neon.password, rolePasswordContext(roleId))
      const region = await db
        .selectFrom("region")
        .select("id")
        .where("isActive", "=", true)
        .executeTakeFirstOrThrow()

      await db
        .insertInto("user")
        .values({ id: ids.user, email: `agent-branch-${ids.user}@test.invalid` })
        .execute()
      await db
        .insertInto("organization")
        .values({
          id: ids.organization,
          name: "Agent Branch Proof",
          slug: `agent-branch-${ids.organization.slice(-12)}`,
          kind: "personal",
          ownerUserId: ids.user,
        })
        .execute()
      await db
        .insertInto("repository")
        .values({
          id: ids.repository,
          organizationId: ids.organization,
          githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
          ownerLogin: "agent-branch-proof",
          name: `repo-${ids.repository.slice(-12)}`,
          provenance: "new",
        })
        .execute()
      await db
        .insertInto("project")
        .values({
          id: ids.project,
          organizationId: ids.organization,
          repositoryId: ids.repository,
          name: "Agent Branch Proof",
          slug: `agent-branch-${ids.project.slice(-12)}`,
        })
        .execute()
      await db
        .insertInto("backendService")
        .values({
          id: ids.backendService,
          organizationId: ids.organization,
          projectId: ids.project,
          regionId: region.id,
          name: "agent-branch-db",
          kind: "postgres",
          status: "active",
        })
        .execute()
      await db
        .insertInto("databaseInstance")
        .values({
          id: ids.databaseInstance,
          backendServiceId: ids.backendService,
          projectId: ids.project,
          provider: "neon",
          providerProjectId: providerProject.id,
          region: providerProject.region_id,
          status: "active",
        })
        .execute()
      await db
        .insertInto("databaseBranch")
        .values({
          id: ids.primaryBranch,
          databaseInstanceId: ids.databaseInstance,
          name: "main",
          kind: "primary",
          providerBranchId: providerBranch.id,
          providerBranchName: providerBranch.name,
          host: neon.host,
          isProtected: true,
        })
        .execute()
      await db
        .insertInto("databaseRole")
        .values({
          id: roleId,
          databaseBranchId: ids.primaryBranch,
          roleName: neon.role,
          passwordCiphertext: sealed.ciphertext,
          passwordWrappedDek: sealed.wrappedDek,
          passwordKmsKeyId: sealed.kmsKeyId,
        })
        .execute()

      const sandboxInput = {
        sandboxId: ids.sandbox,
        organizationId: ids.organization,
        projectId: ids.project,
        userId: ids.user,
        sandboxClass: "container",
        alwaysOn: false,
        resources: SNAPSHOT_RESOURCES,
        idleTimeoutS: 900,
      } as const
      const made =
        process.env.SANDBOX_DATABASE_BRANCH_DIRECT_EGRESS === "1"
          ? await (async () => {
              const daytonaConfig = daytonaConfigFromEnv()
              const { outboundProxyUrl: _outboundProxyUrl, ...params } = buildCreateParams(
                daytonaConfig,
                sandboxInput,
              )
              const sdk = new Daytona({
                apiKey: daytonaConfig.apiKey,
                organizationId: daytonaConfig.organizationId,
                ...(daytonaConfig.apiUrl ? { apiUrl: daytonaConfig.apiUrl } : {}),
                ...(daytonaConfig.target ? { target: daytonaConfig.target } : {}),
              })
              const sandbox = await sdk.create(params)
              return { externalId: sandbox.id }
            })()
          : await activeDriver.create(sandboxInput)
      providerSandboxes.push(made.externalId)
      await db
        .insertInto("sandbox")
        .values({
          id: ids.sandbox,
          projectId: ids.project,
          userId: ids.user,
          externalId: made.externalId,
          provider: "daytona",
          state: "running",
        })
        .execute()

      const token = "spa_live_database_branch_proof"
      let creates = 0
      let deletes = 0
      const branches = new Set<string>()
      const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
        try {
          if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(401).end()
            return
          }
          if (request.url === "/branches" && request.method === "POST") {
            const created = await createDevBranch(db, postgresConfig, {
              backendServiceId: ids.backendService,
              organizationId: ids.organization,
              label: "agent-proof",
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              ownerSandboxId: ids.sandbox,
              maxOwnedBranches: MAX_SANDBOX_DATABASE_BRANCHES,
              kind: "dev",
            })
            branches.add(created.databaseBranchId)
            creates++
            let databaseUrl = created.uri
            if (process.env.SANDBOX_DATABASE_BRANCH_DIRECT_EGRESS === "1") {
              const provider = await db
                .selectFrom("databaseBranch")
                .select("providerBranchId")
                .where("id", "=", created.databaseBranchId)
                .executeTakeFirstOrThrow()
              if (provider.providerBranchId === null) throw new Error("branch has no provider id")
              databaseUrl = await api.getConnectionUri({
                projectId: providerProject.id,
                branchId: provider.providerBranchId,
                database: neon.database,
                role: neon.role,
              })
            }
            response.writeHead(201, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            })
            response.end(
              JSON.stringify({
                databaseBranchId: created.databaseBranchId,
                name: created.name,
                databaseUrl,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              }),
            )
            return
          }
          const match = request.url?.match(/^\/branches\/([0-9a-f-]+)$/)
          if (request.method === "DELETE" && match?.[1] !== undefined && branches.has(match[1])) {
            await dropDevBranch(db, postgresConfig, match[1])
            branches.delete(match[1])
            deletes++
            response.writeHead(204).end()
            return
          }
          if (request.url === "/responses" && request.method === "POST") {
            request.setEncoding("utf8")
            let body = ""
            for await (const chunk of request) body += String(chunk)
            const upstream = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiKey!}`,
                "Content-Type": request.headers["content-type"] ?? "application/json",
              },
              body,
            })
            response.statusCode = upstream.status
            const contentType = upstream.headers.get("content-type")
            if (contentType !== null) response.setHeader("Content-Type", contentType)
            if (upstream.body === null) response.end()
            else Readable.fromWeb(upstream.body as never).pipe(response)
            return
          }
          response.writeHead(404).end()
        } catch (error) {
          response.writeHead(500, { "Content-Type": "text/plain" }).end(String(error))
        }
      }
      const server = createServer((request, response) => {
        void handleRequest(request, response)
      })
      await new Promise<void>((resolve) => server.listen(3102, "127.0.0.1", resolve))

      const workspace = activeDriver.workspaceDir
      await activeDriver.exec(made.externalId, ["git", "init", workspace], 60_000)
      await activeDriver.exec(
        made.externalId,
        ["mkdir", "-p", `${workspace}/.git/sproutos/codex`],
        30_000,
      )
      await activeDriver.writeFile(
        made.externalId,
        `${workspace}/.git/sproutos/codex/AGENTS.md`,
        renderSproutosSkill({
          apiUrl: actionPublicUrl!,
          tenantDomain: "sproutos.run",
          projectSlug: "agent-branch-proof",
          workspacePath: workspace,
        }),
      )
      await activeDriver.writeFile(
        made.externalId,
        `${workspace}/${SANDBOX_NETWORK_LAUNCHER}`,
        SANDBOX_NETWORK_LAUNCHER_SOURCE,
      )

      const events: unknown[] = []
      try {
        const result = await runSandboxTurn({
          actionUrl: `${actionPublicUrl!}/unused`,
          databaseBranchesUrl: `${actionPublicUrl!}/branches`,
          groupPrimaryCandidates: [],
          driver: activeDriver,
          externalId: made.externalId,
          harness: "codex",
          model: process.env.SANDBOX_DATABASE_BRANCH_MODEL ?? "gpt-5.4",
          onEvent: (event) => events.push(event),
          prompt:
            "This empty project needs a database smoke test. Follow the injected SproutOS instructions to create a disposable database branch, connect through the required network launcher, run `select current_database()`, write only the database name to branch-proof.txt, then delete the branch early. Do not ask me for a URL and do not print credentials.",
          proxyBaseUrl: actionPublicUrl!,
          projectSlug: "agent-branch-proof",
          refreshUrl: `${actionPublicUrl!}/unused`,
          timeoutMs: 10 * 60 * 1000,
          token: {
            id: v7(),
            accessToken: token,
            refreshToken: "unused",
            accessExpiresAt: new Date(Date.now() + 35 * 60 * 1000),
            refreshExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          },
          touch: () => Promise.resolve(),
        })
        if (result.exitCode !== 0) {
          throw new Error(`agent exited ${result.exitCode}: ${JSON.stringify(events)}`)
        }
        expect(creates).toBe(1)
        expect(deletes).toBe(1)
        expect(branches.size).toBe(0)
        expect(
          (await activeDriver.readFile(made.externalId, `${workspace}/branch-proof.txt`)).trim(),
        ).toBe(neon.database)
      } finally {
        for (const branch of branches)
          await dropDevBranch(db, postgresConfig, branch).catch(() => undefined)
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        })
      }
    }, 900_000)
  },
)
