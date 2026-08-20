import { crudAuditLog } from "@lib/dao"
import {
  ServiceKindUnavailableError,
  ServiceNotProvisionedError,
  sproutPostgresConfigFromEnv,
  sproutPostgresDriver,
} from "@lib/services"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  servicesSchemaConnectionResponse,
  servicesSchemaCreateRequest,
  servicesSchemaIdParam,
  servicesSchemaListResponse,
} from "./services.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * TASK 37: a customer can provision a backend service on its own and get a connection URI, without
 * it belonging to a project. `backend_service.project_id` is nullable for exactly that.
 *
 * One driver interface behind these routes, so adding Valkey and Elasticsearch is a driver rather
 * than a second set of endpoints with their own shapes.
 */
function driverFor(kind: string) {
  if (kind === "postgres") return sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
  // Named rather than 500ing, because "not yet" is a different answer from "something broke" and
  // the customer can act on one of them.
  throw new ServiceKindUnavailableError(kind)
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/services",
    describeRoute({
      description: "Lists the organization's backend services. Never includes a connection URI",
      responses: {
        200: {
          description: "Services",
          content: { "application/json": { schema: resolver(servicesSchemaListResponse) } },
        },
        403: { description: "Caller lacks database:read", ...errorResponse },
      },
    }),
    requirePermission("database:read"),
    async (c) => {
      const rows = await db
        .selectFrom("backendService")
        .leftJoin("databaseInstance", (join) =>
          join
            .onRef("databaseInstance.backendServiceId", "=", "backendService.id")
            .on("databaseInstance.deletedAt", "is", null),
        )
        .leftJoin("databaseBranch", (join) =>
          join
            .onRef("databaseBranch.databaseInstanceId", "=", "databaseInstance.id")
            .on("databaseBranch.kind", "=", "primary"),
        )
        .leftJoin("databaseRole", "databaseRole.databaseBranchId", "databaseBranch.id")
        .select([
          "backendService.id as id",
          "backendService.name as name",
          "backendService.kind as kind",
          "backendService.status as status",
          "backendService.projectId as projectId",
          "backendService.createdAt as createdAt",
          "databaseBranch.host as host",
          "databaseRole.roleName as username",
        ])
        .where("backendService.organizationId", "=", c.var.organization.id)
        .where("backendService.deletedAt", "is", null)
        .orderBy("backendService.createdAt", "desc")
        .execute()

      const config = safeConfig()

      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind as "postgres",
          status: row.status,
          projectId: row.projectId,
          host: row.host,
          port: row.host === null ? null : config.publicPort,
          database: row.username === null ? null : databaseNameOf(row.id),
          username: row.username,
          createdAt: row.createdAt.toISOString(),
        })),
      })
    },
  )
  .post(
    "/:orgSlug/services",
    describeRoute({
      description: "Provisions a backend service and returns its connection URI, once",
      responses: {
        201: {
          description: "Provisioned",
          content: {
            "application/json": { schema: resolver(servicesSchemaConnectionResponse) },
          },
        },
        400: {
          description: "Unsupported kind, or the project is not this organization's",
          ...errorResponse,
        },
        403: { description: "Caller lacks database:create", ...errorResponse },
      },
    }),
    requirePermission("database:create"),
    validator("json", servicesSchemaCreateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const organization = c.var.organization

      if (body.projectId != null) {
        // The foreign key proves the project exists, not that it is this organization's.
        const owned = await db
          .selectFrom("project")
          .select("id")
          .where("id", "=", body.projectId)
          .where("organizationId", "=", organization.id)
          .where("deletedAt", "is", null)
          .executeTakeFirst()
        if (owned === undefined) {
          return throwBadRequest(c, "That project does not belong to this organization")
        }
      }

      const region = await db.selectFrom("region").select("id").orderBy("id").executeTakeFirst()
      if (region === undefined) return throwBadRequest(c, "No region is configured")

      const backendServiceId = v7()
      await db
        .insertInto("backendService")
        .values({
          id: backendServiceId,
          organizationId: organization.id,
          projectId: body.projectId ?? null,
          regionId: region.id,
          name: body.name,
          kind: body.kind,
          status: "provisioning",
        })
        .execute()

      try {
        const result = await driverFor(body.kind).provision({
          backendServiceId,
          organizationId: organization.id,
          projectId: body.projectId ?? null,
          name: body.name,
        })

        await db
          .updateTable("backendService")
          .set({ status: "active", updatedAt: new Date() })
          .where("id", "=", backendServiceId)
          .execute()

        await crudAuditLog(db).record({
          organizationId: organization.id,
          actorUserId: c.var.user.id,
          action: "database:create",
          resourceSrn: srnFor("db", organization.id, "service", backendServiceId),
          after: { kind: body.kind, name: body.name, database: result.database },
          ...auditContext(c),
        })

        return c.json({ id: backendServiceId, connectionUri: result.connectionUri }, 201)
      } catch (error) {
        // The row stays, marked `error`, rather than being deleted: provisioning may have created
        // a database before it failed, and a row is what `destroy` needs to clean that up.
        await db
          .updateTable("backendService")
          .set({ status: "error", updatedAt: new Date() })
          .where("id", "=", backendServiceId)
          .execute()

        if (error instanceof ServiceKindUnavailableError) {
          return throwBadRequest(c, `${String(body.kind)} services are not available yet`)
        }
        throw error
      }
    },
  )
  .post(
    "/:orgSlug/services/:serviceId/connection",
    describeRoute({
      description: "Reveals the connection URI. Audited, because a credential leaves the system",
      responses: {
        200: {
          description: "Connection URI",
          content: {
            "application/json": { schema: resolver(servicesSchemaConnectionResponse) },
          },
        },
        403: { description: "Caller lacks database:connect", ...errorResponse },
        404: { description: "No such service", ...errorResponse },
      },
    }),
    requirePermission("database:connect"),
    validator("param", servicesSchemaIdParam),
    async (c) => {
      const { serviceId } = c.req.valid("param")
      const service = await owned(c.var.organization.id, serviceId)
      if (service === undefined) return throwNotFound(c, "Service not found")

      try {
        const connectionUri = await driverFor(service.kind).connectionUri(serviceId)

        await crudAuditLog(db).record({
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          action: "database:connect",
          resourceSrn: srnFor("db", c.var.organization.id, "service", serviceId),
          // Records that the credential was read and by whom — never the credential.
          after: { revealed: true },
          ...auditContext(c),
        })

        return c.json({ id: serviceId, connectionUri })
      } catch (error) {
        if (error instanceof ServiceNotProvisionedError) {
          return throwBadRequest(c, "That service has not finished provisioning")
        }
        throw error
      }
    },
  )
  .post(
    "/:orgSlug/services/:serviceId/rotate",
    describeRoute({
      description: "Issues a new password and invalidates the old URI",
      responses: {
        200: {
          description: "New connection URI",
          content: {
            "application/json": { schema: resolver(servicesSchemaConnectionResponse) },
          },
        },
        403: { description: "Caller lacks database:admin", ...errorResponse },
        404: { description: "No such service", ...errorResponse },
      },
    }),
    requirePermission("database:admin"),
    validator("param", servicesSchemaIdParam),
    async (c) => {
      const { serviceId } = c.req.valid("param")
      const service = await owned(c.var.organization.id, serviceId)
      if (service === undefined) return throwNotFound(c, "Service not found")

      try {
        const connectionUri = await driverFor(service.kind).rotateCredentials(serviceId)

        await crudAuditLog(db).record({
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          action: "database:admin",
          resourceSrn: srnFor("db", c.var.organization.id, "service", serviceId),
          after: { rotated: true },
          ...auditContext(c),
        })

        return c.json({ id: serviceId, connectionUri })
      } catch (error) {
        if (error instanceof ServiceNotProvisionedError) {
          return throwBadRequest(c, "That service has not finished provisioning")
        }
        throw error
      }
    },
  )
  .delete(
    "/:orgSlug/services/:serviceId",
    describeRoute({
      description: "Destroys a backend service and everything in it",
      responses: {
        200: {
          description: "Destroyed",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks database:delete", ...errorResponse },
        404: { description: "No such service", ...errorResponse },
      },
    }),
    requirePermission("database:delete"),
    validator("param", servicesSchemaIdParam),
    async (c) => {
      const { serviceId } = c.req.valid("param")
      const service = await owned(c.var.organization.id, serviceId)
      if (service === undefined) return throwNotFound(c, "Service not found")

      await driverFor(service.kind).destroy(serviceId)

      // Soft delete, per ADR 0017: usage_event references this service and a hard delete would
      // take the billing history with it.
      await db
        .updateTable("backendService")
        .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
        .where("id", "=", serviceId)
        .execute()

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "database:delete",
        resourceSrn: srnFor("db", c.var.organization.id, "service", serviceId),
        after: { destroyed: true },
        ...auditContext(c),
      })

      return c.json({})
    },
  )

async function owned(organizationId: string, serviceId: string) {
  return await db
    .selectFrom("backendService")
    .select(["id", "kind", "name"])
    .where("id", "=", serviceId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
}

/** Reading the config can throw if the cluster is unconfigured; a list should still render. */
function safeConfig(): { publicPort: number } {
  try {
    return sproutPostgresConfigFromEnv()
  } catch {
    return { publicPort: 5432 }
  }
}

function databaseNameOf(backendServiceId: string): string {
  return `sprout_db_${backendServiceId.replaceAll("-", "").toLowerCase()}`
}

export default app
