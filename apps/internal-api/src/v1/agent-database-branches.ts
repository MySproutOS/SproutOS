import { resolveProxyAccessToken } from "@lib/agent"
import {
  crudAuditLog,
  fetchAgentSession,
  fetchOrganization,
  fetchOrganizationMember,
  fetchProject,
  fetchSandbox,
  fetchSandboxDatabaseBranch,
  fetchUser,
  sandboxScopeFor,
} from "@lib/dao"
import { srnFor } from "@lib/srn"
import {
  createDevBranch,
  DevBranchNameConflictError,
  DevBranchQuotaExceededError,
  DevBranchUnavailableError,
  dropDevBranch,
  MAX_SANDBOX_DATABASE_BRANCHES,
  neonPostgresConfigFromEnv,
} from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { readBearerToken } from "../bearer"
import { hasPermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import {
  throwConflict,
  throwError,
  throwForbidden,
  throwNotFound,
  throwTooManyRequests,
  throwUnauthenticated,
} from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  agentDatabaseBranchSchemaDeleteParam,
  agentDatabaseBranchSchemaParam,
  agentDatabaseBranchSchemaRequest,
  agentDatabaseBranchSchemaResponse,
} from "./agent-database-branches.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const ADDITIONAL_BRANCH_TTL_MS = 24 * 60 * 60 * 1000

type Dependencies = {
  config: typeof neonPostgresConfigFromEnv
  create: typeof createDevBranch
  drop: typeof dropDevBranch
  now: () => Date
}

const defaults: Dependencies = {
  config: neonPostgresConfigFromEnv,
  create: createDevBranch,
  drop: dropDevBranch,
  now: () => new Date(),
}

function invalidToken(c: Parameters<typeof throwUnauthenticated>[0]) {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
  return throwUnauthenticated(c, "The agent token is not valid")
}

async function scopeForAction(
  c: Parameters<typeof invalidToken>[0],
  input: { orgSlug: string; projectId: string },
) {
  const bearer = readBearerToken(c.req.header("authorization"))
  if (bearer === null) return { response: invalidToken(c) } as const
  const token = await resolveProxyAccessToken(db, bearer)
  if (
    token === undefined ||
    token.actorUserId === null ||
    token.agentSessionId === null ||
    token.agentTurnId === null ||
    token.projectId === null
  ) {
    return { response: invalidToken(c) } as const
  }

  const organization = await fetchOrganization(db).getBySlug(input.orgSlug, [
    "id",
    "slug",
    "name",
    "kind",
    "ownerUserId",
  ])
  if (
    organization === undefined ||
    organization.id !== token.organizationId ||
    input.projectId !== token.projectId
  ) {
    return { response: throwNotFound(c, "Agent action scope not found") } as const
  }

  const [user, membership, session, turn, project] = await Promise.all([
    fetchUser(db).getOne(token.actorUserId, ["id", "deletedAt"]),
    fetchOrganizationMember(db).getForUser(organization.id, token.actorUserId),
    fetchAgentSession(db).getInOrganization(organization.id, input.projectId, token.agentSessionId),
    fetchAgentSession(db).getTurnInSession(token.agentSessionId, token.agentTurnId),
    fetchProject(db).getInOrganization(organization.id, input.projectId, ["id"]),
  ])
  if (user === undefined || user.deletedAt !== null) return { response: invalidToken(c) } as const
  if (membership === undefined || membership.status !== "active" || project === undefined) {
    return { response: throwNotFound(c, "Agent action scope not found") } as const
  }
  if (session === undefined || turn === undefined || turn.resultSubtype !== null) {
    return { response: invalidToken(c) } as const
  }

  const sandboxProjectId = await sandboxScopeFor(db, organization.id, input.projectId)
  if (sandboxProjectId === undefined) {
    return { response: throwNotFound(c, "No sandbox for this project") } as const
  }
  const sandbox = await fetchSandbox(db).forUser(
    organization.id,
    sandboxProjectId,
    token.actorUserId,
  )
  if (sandbox === undefined || sandbox.state !== "running") {
    return { response: throwConflict(c, "No running sandbox is available") } as const
  }
  const backendServiceId = await fetchSandbox(db).postgresServiceIdForScope(sandboxProjectId)
  if (backendServiceId === undefined) {
    return { response: throwConflict(c, "This project has no active Postgres service") } as const
  }

  return {
    actorUserId: token.actorUserId,
    agentSessionId: token.agentSessionId,
    agentTurnId: token.agentTurnId,
    backendServiceId,
    organization,
    sandbox,
    tokenId: token.id,
  } as const
}

export function createAgentDatabaseBranchesApp(dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies }
  return new Hono()
    .post(
      "/:orgSlug/projects/:projectId/agent/actions/database-branches",
      describeRoute({
        description: "Creates a short-lived Neon branch for the active sandbox turn",
        responses: {
          201: {
            description: "A branch-scoped pg-proxy URL returned exactly once",
            content: {
              "application/json": { schema: resolver(agentDatabaseBranchSchemaResponse) },
            },
          },
          401: {
            description: "The short-lived agent token is absent or invalid",
            ...errorResponse,
          },
          403: {
            description: "The initiating user lacks database:branch:create",
            ...errorResponse,
          },
          404: { description: "The token does not belong to this scope", ...errorResponse },
          409: {
            description: "No running sandbox or active Postgres service is available",
            ...errorResponse,
          },
          429: {
            description: "The sandbox or Neon project branch quota is full",
            ...errorResponse,
          },
          503: { description: "Neon is unavailable or not configured", ...errorResponse },
        },
      }),
      validator("param", agentDatabaseBranchSchemaParam),
      validator("json", agentDatabaseBranchSchemaRequest),
      async (c) => {
        const scoped = await scopeForAction(c, c.req.valid("param"))
        if ("response" in scoped) return scoped.response
        if (
          !(await hasPermission(scoped.actorUserId, scoped.organization, "database:branch:create", {
            service: "db",
            type: "service",
            id: scoped.backendServiceId,
          }))
        ) {
          return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
        }

        const requestedName = c.req.valid("json").name
        const expiresAt = new Date(deps.now().getTime() + ADDITIONAL_BRANCH_TTL_MS)
        let branch
        try {
          branch = await deps.create(db, deps.config(), {
            backendServiceId: scoped.backendServiceId,
            organizationId: scoped.organization.id,
            label: requestedName,
            expiresAt,
            ownerSandboxId: scoped.sandbox.id,
            maxOwnedBranches: MAX_SANDBOX_DATABASE_BRANCHES,
            kind: "dev",
          })
        } catch (error) {
          if (error instanceof DevBranchQuotaExceededError) {
            return throwTooManyRequests(c, error.message)
          }
          if (error instanceof DevBranchNameConflictError) return throwConflict(c, error.message)
          if (error instanceof DevBranchUnavailableError) return throwConflict(c, error.message)
          return throwError(
            c,
            503,
            ErrorCode.ServiceUnavailable,
            "The database provider is unavailable",
          )
        }

        try {
          await crudAuditLog(db).record({
            action: "database:branch:create",
            actorUserId: scoped.actorUserId,
            after: {
              agentProxyTokenId: scoped.tokenId,
              agentSessionId: scoped.agentSessionId,
              agentTurnId: scoped.agentTurnId,
              expiresAt: expiresAt.toISOString(),
              name: branch.name,
              sandboxId: scoped.sandbox.id,
              source: "agent",
            },
            organizationId: scoped.organization.id,
            resourceSrn: srnFor("db", scoped.organization.id, "branch", branch.databaseBranchId),
            ...auditContext(c),
          })
        } catch (error) {
          try {
            await deps.drop(db, deps.config(), branch.databaseBranchId)
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `the branch audit failed and branch ${branch.databaseBranchId} could not be removed`,
              { cause: error },
            )
          }
          throw error
        }
        c.header("Cache-Control", "no-store")
        return c.json(
          {
            databaseBranchId: branch.databaseBranchId,
            name: branch.name,
            databaseUrl: branch.uri,
            expiresAt: expiresAt.toISOString(),
          },
          201,
        )
      },
    )
    .delete(
      "/:orgSlug/projects/:projectId/agent/actions/database-branches/:databaseBranchId",
      describeRoute({
        description: "Deletes an additional database branch owned by this sandbox",
        responses: {
          204: { description: "The additional branch was deleted" },
          401: {
            description: "The short-lived agent token is absent or invalid",
            ...errorResponse,
          },
          403: {
            description: "The initiating user lacks database:branch:delete",
            ...errorResponse,
          },
          404: {
            description: "The branch is not an additional branch of this sandbox",
            ...errorResponse,
          },
          503: { description: "Neon is unavailable or not configured", ...errorResponse },
        },
      }),
      validator("param", agentDatabaseBranchSchemaDeleteParam),
      async (c) => {
        const params = c.req.valid("param")
        const scoped = await scopeForAction(c, params)
        if ("response" in scoped) return scoped.response
        if (
          !(await hasPermission(scoped.actorUserId, scoped.organization, "database:branch:delete", {
            service: "db",
            type: "service",
            id: scoped.backendServiceId,
          }))
        ) {
          return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
        }
        const owned = await fetchSandboxDatabaseBranch(db).getAdditional(
          scoped.sandbox.id,
          params.databaseBranchId,
        )
        if (owned === undefined) return throwNotFound(c, "Additional database branch not found")

        try {
          await deps.drop(db, deps.config(), params.databaseBranchId)
        } catch {
          return throwError(
            c,
            503,
            ErrorCode.ServiceUnavailable,
            "The database provider is unavailable",
          )
        }
        await crudAuditLog(db).record({
          action: "database:branch:delete",
          actorUserId: scoped.actorUserId,
          after: {
            agentProxyTokenId: scoped.tokenId,
            agentSessionId: scoped.agentSessionId,
            agentTurnId: scoped.agentTurnId,
            sandboxId: scoped.sandbox.id,
            source: "agent",
          },
          organizationId: scoped.organization.id,
          resourceSrn: srnFor("db", scoped.organization.id, "branch", params.databaseBranchId),
          ...auditContext(c),
        })
        return c.body(null, 204)
      },
    )
}

export default createAgentDatabaseBranchesApp()
