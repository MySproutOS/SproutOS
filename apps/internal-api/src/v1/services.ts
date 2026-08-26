import { crudAuditLog } from "@lib/dao"
import {
  ServiceKindUnavailableError,
  ServiceNotConfiguredError,
  ServiceNotProvisionedError,
  neonPostgresDriverFromEnv,
  objectStorageDriverFromEnv,
  searchDriver,
  searchServiceConfigFromEnv,
  sproutPostgresConfigFromEnv,
  sproutPostgresDriver,
  valkeyDriver,
  valkeyServiceConfigFromEnv,
} from "@lib/services"
import { srnFor } from "@lib/srn"
import { publishQueue } from "@lib/lambda"
import { encodeShortId } from "@lib/services"
import { Redis } from "ioredis"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { v7 } from "uuid"
import { type AuthContext, authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwError, throwNotFound } from "../utils/http-exception"
import { ErrorCode } from "../utils/errors.enum"
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
export function driverFor(kind: string) {
  /*
    All three kinds, because all three drivers exist.

    `valkeyDriver` and `searchDriver` were written, exported from `@lib/services`, and covered by
    `valkey.test.ts` and `search.test.ts` — and this function dispatched only `postgres`, so asking
    for either answered "valkey services are not available yet". The drivers were complete; the
    two-line dispatch was not.

    `ServiceKindUnavailableError` still stands, and still means what it says. It now fires for a
    kind whose driver genuinely does not exist, rather than for one sitting unreferenced in the
    package next door.

    Each `…ConfigFromEnv` throws when its own variables are missing, which is the right failure: a
    deployment that has no OpenSearch should say so when someone asks for a search service, not
    when the process starts.
  */
  /*
    Postgres: `neon` where the storage layer is deployed, `sprout` everywhere else.

    Chosen by configuration rather than per-service, because the difference is what a database *is* —
    a role on a shared cluster, or a tenant and a timeline in a pageserver — and a platform running
    both for the same customer would have two answers to "restore my database" and two meanings for
    a branch.

    `sprout` is still the default. Existing databases are `sprout` and moving them is a migration
    rather than a flag; a deployment flips this when its Neon stack is up and its tenants have been
    moved. `database_instance.provider` records which one each database actually was, so a mixed
    estate during that migration is readable rather than ambiguous.
  */
  if (kind === "postgres") {
    return process.env.SERVICE_POSTGRES_PROVIDER === "neon"
      ? neonPostgresDriverFromEnv(db)
      : sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
  }
  if (kind === "valkey") return valkeyDriver(db, valkeyServiceConfigFromEnv())
  if (kind === "elasticsearch") return searchDriver(db, searchServiceConfigFromEnv())
  /*
    Object storage: the other way to run a vault.

    `obsidian-livesync` replicates against either a CouchDB or an S3-compatible bucket, and a bucket
    is nobody's server to run. The driver speaks S3 to whatever endpoint it is given — AWS, GCS's XML
    API, MinIO, LocalStack — and the cloud-specific half is issuing a bucket-scoped credential.
  */
  if (kind === "object_storage") return objectStorageDriverFromEnv(db)
  // Named rather than 500ing, because "not yet" is a different answer from "something broke" and
  // the customer can act on one of them.
  throw new ServiceKindUnavailableError(kind)
}

/**
 * Record which OAuth grant created a service, and which grant owns its credential.
 *
 * A no-op for a person at a browser — `auth.kind` is `session` and the credential is theirs, which
 * is what a null `oauth_grant_id` means.
 *
 * For an application it is the thing that makes consent revocable. Without it the application and
 * the user hold the same secret: revoking the application's access cannot revoke its database
 * access without breaking the user's own URI, and rotating to force the issue breaks every other
 * consumer, because rotation revokes every live credential on the service.
 *
 * Done here rather than inside each driver. Four drivers mint credentials and threading a grant id
 * through all four signatures is four places for it to be forgotten — this is one, on the path
 * every kind already takes.
 */
async function attributeToGrant(auth: AuthContext, backendServiceId: string): Promise<void> {
  // The value, not the `Context` it came from: Hono's context is invariant in its variables, so a
  // helper typed on a narrower one cannot accept a route's wider one — and typing it as a bare
  // `Context` makes `auth` an `any`, which turns the `kind` check below into no check at all.
  if (auth.kind !== "oauth") return

  await db
    .updateTable("backendService")
    .set({ createdByOauthGrantId: auth.oauthGrantId })
    .where("id", "=", backendServiceId)
    .execute()

  /*
    Only the live credential, and only the one with no grant yet.

    A rotation performed by an application should attribute the *new* secret to it and leave the
    revoked ones as the historical record of who held what. Matching on `revoked_at is null` is
    what keeps a rotation from rewriting the past.
  */
  await db
    .updateTable("serviceCredential")
    .set({ oauthGrantId: auth.oauthGrantId })
    .where("backendServiceId", "=", backendServiceId)
    .where("revokedAt", "is", null)
    .where("oauthGrantId", "is", null)
    .execute()
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

        // Attributed to the grant that asked for it, if an application did.
        await attributeToGrant(c.var.auth, backendServiceId)

        /*
          Capture the queue's URI now, because this is the only moment it exists.

          `service_credential` stores a hash — deliberately, so a stolen credential table is
          worthless — which means `connectionUri` can never rebuild this and does not pretend to.
          A worker the platform starts on the customer's behalf (`dispatchQueues`, TASK 20) still
          has to authenticate, so the plaintext on its way out of here is written into a Secret in
          the tenant's own namespace and nowhere else.

          Failing to write it must not fail the provision: the customer has their URI, the service
          works, and the only thing lost is the platform's ability to start a worker — which it
          reports rather than pretending about. Rotating the credential writes it again.
        */
        if (body.kind === "valkey") {
          await captureQueueSecret(organization.id, backendServiceId, result.connectionUri)
        }

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

        /*
          Misconfigured is not crashed, and the customer should not be told it is.

          The `*ConfigFromEnv` functions threw a bare `Error` naming the missing variable, this
          `throw` rethrew it, and the customer received `500 Internal Server Error` with no body —
          for postgres, valkey and elasticsearch alike, which is every database this product sells.
          A 500 says "we broke, try again"; the truth was "this deployment was never told where its
          databases live", and no amount of retrying fixes that.

          503 rather than 500, because the condition is temporary in the only sense that matters: it
          ends when an operator sets the value. The variable is named in the message deliberately —
          the only person who can act on this is reading logs or a support ticket, and "postgres is
          unavailable" would send them looking at a database rather than at Parameter Store.
        */
        if (error instanceof ServiceNotConfiguredError) {
          console.error(`[services] ${error.message}`)
          return throwError(
            c,
            503,
            ErrorCode.ServiceUnavailable,
            `${String(body.kind)} services are not configured on this deployment (${error.variable} is not set). This is a platform configuration problem, not a problem with your project.`,
          )
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

        // The replacement belongs to whoever rotated it. An application rotating its own credential
        // keeps it revocable; a user rotating takes ownership, which is how they take a database
        // back from an application without deleting it.
        await attributeToGrant(c.var.auth, serviceId)

        /*
          Rotation is also how a queue provisioned before workers existed gets a Secret.

          There is no way to make one from a hash, so the platform cannot repair it silently — and
          rotating a running application's credential without being asked is not something to do
          quietly. A customer who wants a worker rotates, which they already understand as "the old
          URI stops working".
        */
        if (service.kind === "valkey") {
          await captureQueueSecret(c.var.organization.id, serviceId, connectionUri)
        }

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

/**
 * Publish one queue for the router to watch.
 *
 * Never throws. A provision that succeeded must not be reported as a failure because the platform
 * could not set itself up to run workers later — the customer has a working queue and a URI, and
 * the consequence of this failing is that their workflows do not run, which is visible and
 * recoverable.
 *
 * This used to write a Kubernetes Secret into the tenant's namespace for a worker Deployment to
 * mount. There is no namespace and no Deployment: the router watches the queue and invokes a Lambda
 * per batch, so what it needs is a key it can read.
 */
async function captureQueueSecret(
  organizationId: string,
  backendServiceId: string,
  connectionUri: string,
): Promise<void> {
  const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  try {
    // Keyed by the short id the proxy reports, which is what the tenant's key prefix carries.
    await publishQueue(valkey, encodeShortId(backendServiceId), {
      uri: connectionUri,
      backendServiceId,
      projectId: null,
      organizationId,
    })

    /*
      Recorded after the write, not before.

      A row claiming a binding that was never published would have the router told to watch a queue
      it cannot reach, so the order matters — the same reasoning as when this wrote a Secret.
    */
    await db
      .updateTable("backendService")
      .set({ workerSecretAt: new Date(), updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  } catch (cause) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "could not publish the queue binding; workflows will not run for this service",
        backendServiceId,
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  } finally {
    valkey.disconnect()
  }
}
