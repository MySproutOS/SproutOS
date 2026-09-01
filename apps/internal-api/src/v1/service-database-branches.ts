import { crudAuditLog, fetchBackendService, fetchDatabaseBranch } from "@lib/dao"
import {
  createDevBranch,
  DevBranchHasChildrenError,
  DevBranchNameConflictError,
  DevBranchQuotaExceededError,
  DevBranchUnavailableError,
  dropDevBranch,
  neonPostgresConfigFromEnv,
  rotateDevBranchCredential,
} from "@lib/services"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import {
  throwConflict,
  throwError,
  throwNotFound,
  throwTooManyRequests,
} from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  serviceDatabaseBranchConnectionSchemaResponse,
  serviceDatabaseBranchSchemaParam,
  serviceDatabaseBranchSchemaRequest,
  serviceDatabaseBranchSchemaResponse,
  serviceDatabaseBranchesSchemaParam,
  serviceDatabaseBranchesSchemaResponse,
} from "./service-database-branches.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

async function postgresService(organizationId: string, serviceId: string) {
  const service = await fetchBackendService(db).getInOrganization(organizationId, serviceId, [
    "id",
    "kind",
    "status",
  ])
  return service?.kind === "postgres" && service.status === "active" ? service : undefined
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/services/:serviceId/branches",
    describeRoute({
      description: "Lists every active branch of a managed Postgres service",
      responses: {
        200: {
          description: "Database branches",
          content: {
            "application/json": { schema: resolver(serviceDatabaseBranchesSchemaResponse) },
          },
        },
        403: { description: "Caller lacks database:read", ...errorResponse },
        404: { description: "No active managed Postgres service", ...errorResponse },
      },
    }),
    requirePermission("database:read"),
    validator("param", serviceDatabaseBranchesSchemaParam),
    async (c) => {
      const { serviceId } = c.req.valid("param")
      if ((await postgresService(c.var.organization.id, serviceId)) === undefined) {
        return throwNotFound(c, "Postgres service not found")
      }
      const branches = await fetchDatabaseBranch(db).listForService(
        c.var.organization.id,
        serviceId,
      )
      return c.json({
        data: branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          kind: branch.kind,
          parentDatabaseBranchId: branch.parentBranchId,
          isProtected: branch.isProtected,
          status: branch.provisioningState,
          createdAt: branch.createdAt.toISOString(),
          expiresAt: branch.expiresAt?.toISOString() ?? null,
        })),
      })
    },
  )
  .post(
    "/:orgSlug/services/:serviceId/branches",
    describeRoute({
      description: "Creates a persistent user-managed Neon branch",
      responses: {
        201: {
          description: "Branch and its one-time connection URI",
          content: {
            "application/json": { schema: resolver(serviceDatabaseBranchSchemaResponse) },
          },
        },
        403: { description: "Caller lacks database:branch:create", ...errorResponse },
        404: { description: "Service or parent branch not found", ...errorResponse },
        409: { description: "Branch name or parent state conflicts", ...errorResponse },
        429: { description: "Neon project branch quota is full", ...errorResponse },
        503: { description: "Neon is unavailable", ...errorResponse },
      },
    }),
    requirePermission("database:branch:create"),
    validator("param", serviceDatabaseBranchesSchemaParam),
    validator("json", serviceDatabaseBranchSchemaRequest),
    async (c) => {
      const { serviceId } = c.req.valid("param")
      if ((await postgresService(c.var.organization.id, serviceId)) === undefined) {
        return throwNotFound(c, "Postgres service not found")
      }
      const body = c.req.valid("json")
      const parent = await fetchDatabaseBranch(db).getInService(
        c.var.organization.id,
        serviceId,
        body.parentDatabaseBranchId,
      )
      if (parent === undefined || parent.provisioningState !== "active") {
        return throwNotFound(c, "Active parent branch not found")
      }

      try {
        const branch = await createDevBranch(db, neonPostgresConfigFromEnv(), {
          backendServiceId: serviceId,
          organizationId: c.var.organization.id,
          label: body.name,
          parentDatabaseBranchId: parent.id,
          createdByUserId: c.var.user.id,
          kind: "user",
        })
        const persisted = await fetchDatabaseBranch(db).getOne(branch.databaseBranchId, [
          "createdAt",
        ])
        if (persisted === undefined) throw new Error("created database branch disappeared")
        await crudAuditLog(db).record({
          action: "database:branch:create",
          actorUserId: c.var.user.id,
          after: { name: branch.name, parentDatabaseBranchId: parent.id, source: "user" },
          organizationId: c.var.organization.id,
          resourceSrn: srnFor("db", c.var.organization.id, "branch", branch.databaseBranchId),
          ...auditContext(c),
        })
        c.header("Cache-Control", "no-store")
        return c.json(
          {
            id: branch.databaseBranchId,
            name: branch.name,
            kind: "user",
            parentDatabaseBranchId: parent.id,
            isProtected: false,
            status: "active",
            createdAt: persisted.createdAt.toISOString(),
            expiresAt: null,
            connectionUri: branch.uri,
          },
          201,
        )
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
    },
  )
  .post(
    "/:orgSlug/services/:serviceId/branches/:databaseBranchId/rotate",
    describeRoute({
      description: "Rotates one branch-scoped credential",
      responses: {
        200: {
          description: "One-time replacement connection URI",
          content: {
            "application/json": { schema: resolver(serviceDatabaseBranchConnectionSchemaResponse) },
          },
        },
        403: { description: "Caller lacks database:connect", ...errorResponse },
        404: { description: "Branch not found", ...errorResponse },
        409: { description: "Branch is not active", ...errorResponse },
        503: { description: "Credential service is unavailable", ...errorResponse },
      },
    }),
    requirePermission("database:connect"),
    validator("param", serviceDatabaseBranchSchemaParam),
    async (c) => {
      const { serviceId, databaseBranchId } = c.req.valid("param")
      const branch = await fetchDatabaseBranch(db).getInService(
        c.var.organization.id,
        serviceId,
        databaseBranchId,
      )
      if (branch === undefined) return throwNotFound(c, "Database branch not found")
      let connectionUri: string
      try {
        connectionUri = await rotateDevBranchCredential(db, neonPostgresConfigFromEnv(), {
          databaseBranchId,
          organizationId: c.var.organization.id,
        })
      } catch (error) {
        if (error instanceof DevBranchUnavailableError) return throwConflict(c, error.message)
        return throwError(
          c,
          503,
          ErrorCode.ServiceUnavailable,
          "The database provider is unavailable",
        )
      }
      await crudAuditLog(db).record({
        action: "database:connect",
        actorUserId: c.var.user.id,
        after: { credentialRotated: true, source: "user" },
        organizationId: c.var.organization.id,
        resourceSrn: srnFor("db", c.var.organization.id, "branch", databaseBranchId),
        ...auditContext(c),
      })
      c.header("Cache-Control", "no-store")
      return c.json({ id: databaseBranchId, connectionUri })
    },
  )
  .delete(
    "/:orgSlug/services/:serviceId/branches/:databaseBranchId",
    describeRoute({
      description: "Deletes an unprotected database branch",
      responses: {
        200: {
          description: "Branch deleted",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks database:branch:delete", ...errorResponse },
        404: { description: "Branch not found", ...errorResponse },
        409: { description: "Branch is protected or still has children", ...errorResponse },
        503: { description: "Neon is unavailable", ...errorResponse },
      },
    }),
    requirePermission("database:branch:delete"),
    validator("param", serviceDatabaseBranchSchemaParam),
    async (c) => {
      const { serviceId, databaseBranchId } = c.req.valid("param")
      const branch = await fetchDatabaseBranch(db).getInService(
        c.var.organization.id,
        serviceId,
        databaseBranchId,
      )
      if (branch === undefined) return throwNotFound(c, "Database branch not found")
      if (branch.isProtected) return throwConflict(c, "Protected branches cannot be deleted")
      try {
        await dropDevBranch(db, neonPostgresConfigFromEnv(), databaseBranchId)
      } catch (error) {
        if (
          error instanceof DevBranchHasChildrenError ||
          error instanceof DevBranchUnavailableError
        ) {
          return throwConflict(c, error.message)
        }
        return throwError(
          c,
          503,
          ErrorCode.ServiceUnavailable,
          "The database provider is unavailable",
        )
      }
      await crudAuditLog(db).record({
        action: "database:branch:delete",
        actorUserId: c.var.user.id,
        after: { source: "user" },
        organizationId: c.var.organization.id,
        resourceSrn: srnFor("db", c.var.organization.id, "branch", databaseBranchId),
        ...auditContext(c),
      })
      return c.json({})
    },
  )

export default app
