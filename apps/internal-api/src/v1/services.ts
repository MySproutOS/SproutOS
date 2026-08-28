import { availableBalance } from "@lib/billing"
import { crudAuditLog, crudProjectEnvVar } from "@lib/dao"
import { sealEnvVarValue } from "@lib/envelope"
import {
  ServiceKindUnavailableError,
  ServiceNotConfiguredError,
  ServiceNotProvisionedError,
  parseObjectStorageUri,
  serviceDriverFromEnv,
  valkeyKeyPrefix,
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
/**
 * The environment variables a given kind of service is conventionally read from.
 *
 * Absent from this map means "no convention we are confident about", and nothing is written — a
 * guessed name is worse than none, because a customer who finds `OBJECT_STORAGE_URL` in their
 * settings will reasonably assume their code is meant to read it.
 *
 * **Valkey gets two names, and that is not hedging.** A Valkey service speaks the Redis protocol,
 * so the ecosystem reads `REDIS_URL` — BullMQ, ioredis and everything built on them — while code
 * written against Valkey by name reads `VALKEY_URL`. Both are correct, they carry the same value,
 * and picking one means the other half of the ecosystem silently falls back to `localhost:6379`.
 * That is exactly what happened here: the first API deployed on this platform started, connected to
 * nothing, and failed with `ECONNREFUSED 127.0.0.1:6379` — a default, not an error.
 */
const CONNECTION_ENV_KEYS: Record<string, string[]> = {
  postgres: ["DATABASE_URL"],
  valkey: ["REDIS_URL", "VALKEY_URL"],
  elasticsearch: ["ELASTICSEARCH_URL"],
}

export function connectionEnvironmentEntries(input: {
  connectionUri: string
  keyPrefix?: string
  kind: string
}): { isSecret: boolean; key: string; value: string }[] {
  if (input.kind === "object_storage") {
    const parsed = parseObjectStorageUri(input.connectionUri)
    return [
      { isSecret: false, key: "S3_ENDPOINT", value: parsed.endpoint },
      { isSecret: false, key: "S3_REGION", value: parsed.region },
      { isSecret: false, key: "S3_BUCKET_NAME", value: parsed.bucket },
      { isSecret: false, key: "S3_FORCE_PATH_STYLE", value: String(parsed.forcePathStyle) },
      { isSecret: true, key: "S3_ACCESS_KEY_ID", value: parsed.accessKeyId },
      { isSecret: true, key: "S3_SECRET_ACCESS_KEY", value: parsed.secretAccessKey },
    ]
  }
  const keys = CONNECTION_ENV_KEYS[input.kind]
  if (keys === undefined) return []
  return [
    ...keys.map((key) => ({ isSecret: true, key, value: input.connectionUri })),
    ...(input.kind === "valkey" && input.keyPrefix !== undefined
      ? [{ isSecret: false, key: "BULLMQ_PREFIX", value: input.keyPrefix }]
      : []),
  ]
}

export function connectionResponse(
  id: string,
  result: { connectionUri: string; keyPrefix?: string },
) {
  return {
    id,
    connectionUri: result.connectionUri,
    ...(result.keyPrefix === undefined ? {} : { keyPrefix: result.keyPrefix }),
  }
}

export function hasProvisioningCredit(availableMicroUsd: bigint): boolean {
  return availableMicroUsd > 0n
}

/**
 * Put the connection URI where the application will actually find it.
 *
 * Provisioning a database wrote nothing into `project_env_var`; `teardown.ts` deleted them and
 * nothing created them. So "deploy an app with a database" meant provisioning it, copying the URI
 * out of the one response that ever contains it, and pasting it back into the project's settings by
 * hand — and getting that wrong looks exactly like the application being broken.
 *
 * **This is the only moment the URI exists.** `service_credential` stores a hash, deliberately, so
 * `connectionUri` cannot rebuild the credential half later and does not pretend to.
 *
 * Not fatal on failure, and marked `is_secret`. A provision that succeeded must not be reported as
 * failed because a convenience did not land — the customer holds the URI either way, and the
 * response still carries it.
 */
async function injectConnectionUri(input: {
  connectionUri: string
  keyPrefix?: string
  kind: string
  projectId: string | null
}): Promise<void> {
  if (input.projectId === null) return
  const entries = connectionEnvironmentEntries(input)

  for (const entry of entries) {
    try {
      const sealed = await sealEnvVarValue(input.projectId, entry.key, entry.value)
      await crudProjectEnvVar(db).upsert({
        isSecret: entry.isSecret,
        key: entry.key,
        projectId: input.projectId,
        // Every environment: a preview deployment that cannot reach the database is a preview that
        // proves nothing. A branch-scoped URI replaces this when the ephemeral-environment work
        // lands.
        target: "all",
        value: sealed,
      })
    } catch (error) {
      // One failing name must not stop the others: a project that got `REDIS_URL` and not
      // `VALKEY_URL` is degraded, and a project that got neither is broken.
      console.error(
        JSON.stringify({
          error: String(error),
          key: entry.key,
          level: "error",
          message: "could not write the connection URI into the project environment",
          projectId: input.projectId,
        }),
      )
    }
  }
}

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
  /*
    Object storage: the other way to run a vault.

    `obsidian-livesync` replicates against either a CouchDB or an S3-compatible bucket, and a bucket
    is nobody's server to run. The driver speaks S3 to whatever endpoint it is given — AWS, GCS's XML
    API, MinIO, LocalStack — and the cloud-specific half is issuing a bucket-scoped credential.
  */
  return serviceDriverFromEnv(db, kind)
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
}

function credentialOwner(auth: AuthContext): { oauthGrantId: string | null } {
  return { oauthGrantId: auth.kind === "oauth" ? auth.oauthGrantId : null }
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
        .leftJoin("oauthGrant", "oauthGrant.id", "backendService.createdByOauthGrantId")
        .leftJoin("oauthClient", "oauthClient.id", "oauthGrant.oauthClientId")
        .select([
          "backendService.id as id",
          "backendService.name as name",
          "backendService.kind as kind",
          "backendService.status as status",
          "backendService.projectId as projectId",
          "backendService.createdAt as createdAt",
          "databaseRole.roleName as username",
          "oauthClient.id as managedByOauthClientId",
          "oauthClient.name as managedByOauthAppName",
        ])
        .where("backendService.organizationId", "=", c.var.organization.id)
        .where("backendService.deletedAt", "is", null)
        .orderBy("backendService.createdAt", "desc")
        .execute()

      return c.json({
        data: rows.map((row) => {
          const endpoint = servicePublicEndpoint(row.kind, row.status)
          return {
            id: row.id,
            name: row.name,
            kind: row.kind as "postgres",
            status: row.status,
            projectId: row.projectId,
            host: endpoint.host,
            port: endpoint.port,
            database: row.username === null ? null : databaseNameOf(row.id),
            username: row.username,
            managedByOauthApp:
              row.managedByOauthClientId === null || row.managedByOauthAppName === null
                ? null
                : { clientId: row.managedByOauthClientId, name: row.managedByOauthAppName },
            ...(row.kind === "valkey" ? { keyPrefix: valkeyKeyPrefix(row.id) } : {}),
            createdAt: row.createdAt.toISOString(),
          }
        }),
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
        402: { description: "The organization has no spendable credit", ...errorResponse },
        403: { description: "Caller lacks database:create", ...errorResponse },
      },
    }),
    requirePermission("database:create"),
    validator("json", servicesSchemaCreateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const organization = c.var.organization

      if (!hasProvisioningCredit(await availableBalance(db, organization.id))) {
        return throwError(
          c,
          402,
          ErrorCode.InsufficientCredit,
          "Add credit before creating a database. Granting database access does not itself charge anything.",
        )
      }

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
          credentialOwner: credentialOwner(c.var.auth),
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

        // The URI exists exactly once, here. If it is not written into the project's environment
        // now, it cannot be later — `connectionUri` rebuilds what it can, but the credential half
        // is stored as a hash on purpose.
        await injectConnectionUri({
          connectionUri: result.connectionUri,
          keyPrefix: result.keyPrefix,
          kind: body.kind,
          projectId: body.projectId ?? null,
        })

        await crudAuditLog(db).record({
          organizationId: organization.id,
          actorUserId: c.var.user.id,
          action: "database:create",
          resourceSrn: srnFor("db", organization.id, "service", backendServiceId),
          after: { kind: body.kind, name: body.name, database: result.database },
          ...auditContext(c),
        })

        return c.json(connectionResponse(backendServiceId, result), 201)
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
        const result = await driverFor(service.kind).rotateCredentials(
          serviceId,
          credentialOwner(c.var.auth),
        )
        const { connectionUri } = result

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

        await injectConnectionUri({
          connectionUri,
          keyPrefix: result.keyPrefix,
          kind: service.kind,
          projectId: service.projectId,
        })

        await crudAuditLog(db).record({
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          action: "database:admin",
          resourceSrn: srnFor("db", c.var.organization.id, "service", serviceId),
          after: { rotated: true },
          ...auditContext(c),
        })

        return c.json(connectionResponse(serviceId, result))
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
    .select(["id", "kind", "name", "projectId"])
    .where("id", "=", serviceId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
}

/**
 * The public proxy address a customer can actually use, never a provider/backend address.
 *
 * `database_branch.host` is a Postgres provider detail. It is null for Valkey and Search, so using
 * it for every kind rendered `—` for both; for Neon it can name the provider host behind pg-proxy,
 * which is not an endpoint the dashboard should encourage anyone to use. The public address is
 * deployment configuration and is deliberately selected by kind here.
 *
 * Listing is fail-soft. A missing or malformed endpoint is an operator configuration problem, but
 * it must not make the entire databases page fail. Provisioning remains fail-closed in each driver.
 */
export function servicePublicEndpoint(
  kind: string,
  status: string,
  env: NodeJS.ProcessEnv = process.env,
): { host: string | null; port: number | null } {
  if (status !== "active") return { host: null, port: null }

  const config =
    kind === "postgres"
      ? {
          host: env.SERVICE_POSTGRES_PUBLIC_HOST,
          port: env.SERVICE_POSTGRES_PUBLIC_PORT,
          fallback: 5432,
        }
      : kind === "valkey"
        ? {
            host: env.SERVICE_VALKEY_PUBLIC_HOST,
            port: env.SERVICE_VALKEY_PUBLIC_PORT,
            fallback: 6379,
          }
        : kind === "elasticsearch"
          ? {
              host: env.SERVICE_SEARCH_PUBLIC_HOST,
              port: env.SERVICE_SEARCH_PUBLIC_PORT,
              fallback: 9200,
            }
          : null

  if (config === null || config.host === undefined || config.host.trim() === "") {
    return { host: null, port: null }
  }

  const port = Number(config.port ?? config.fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { host: null, port: null }
  }

  return { host: config.host, port }
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
