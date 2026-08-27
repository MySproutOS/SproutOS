import { crudAuditLog } from "@lib/dao"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { authMiddleware } from "../middleware"
import { requireMembership } from "../rbac"
import { ErrorSchemaResponse, UUID7String } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import { driverFor } from "./services"
import {
  oauthGrantsSchemaListResponse,
  oauthGrantsSchemaRevokeRequest,
  oauthGrantsSchemaRevokeResponse,
} from "./oauth-grants.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * The applications a person has signed into with SproutOS, and how they take it back.
 *
 * The provider could issue consent and never withdraw it. `oauth_grant` has had a `revoked_at`
 * column since the provider was written, `introspect` has always refused a token whose grant is
 * revoked, and there was no route that set it and no screen that showed one — so a user could
 * authorize an application and had no way to see or undo that.
 *
 * The reason it matters more here than in most providers is that a grant can create *durable
 * things*. An application with `database:create` provisions a real database and is handed a real
 * connection URI. Withdrawing consent has to reach that credential, or "revoked" means the
 * application can no longer call the API while still holding a live database.
 *
 * Scoped to the caller. A grant belongs to one person even though it names an organization, so an
 * organization's other members — including its owner — do not see it here and cannot revoke it.
 * That is deliberate: consent is personal, and an owner who could revoke another member's grant
 * could also silently rotate the credentials of databases that member depends on.
 */
const app = new Hono().use(authMiddleware)

const orgParam = Type.Object({ orgSlug: Type.String() })
const grantParam = Type.Object({ orgSlug: Type.String(), grantId: UUID7String })

/** A grant of this caller's, in this organization, that has not already been revoked. */
async function liveGrant(organizationId: string, userId: string, grantId: string) {
  return await db
    .selectFrom("oauthGrant")
    .select(["id", "oauthClientId", "scopes", "createdAt"])
    .where("id", "=", grantId)
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()
}

/** The services a grant created and that still exist. */
async function servicesOf(grantId: string) {
  return await db
    .selectFrom("backendService")
    .select(["id", "name", "kind", "status", "createdAt"])
    .where("createdByOauthGrantId", "=", grantId)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "asc")
    .execute()
}

const routes = app
  .get(
    "/:orgSlug/oauth-grants",
    describeRoute({
      description: "Applications this user has authorized, and what each one created",
      responses: {
        200: {
          description: "Grants",
          content: { "application/json": { schema: resolver(oauthGrantsSchemaListResponse) } },
        },
      },
    }),
    /*
      `requireMembership`, not `requirePermission`.

      The rows are filtered to `user_id = the caller`, so there is no permission that could widen
      the result and none that should narrow it. A member with no rights in an organization still
      has to be able to see and withdraw their own consent — that is the one thing an organization
      must not be able to take away from them. The middleware still resolves the organization and
      still refuses a non-member, which is the part that matters.
    */
    requireMembership(),
    validator("param", orgParam),
    async (c) => {
      const grants = await db
        .selectFrom("oauthGrant")
        .innerJoin("oauthClient", "oauthClient.id", "oauthGrant.oauthClientId")
        .select([
          "oauthGrant.id as id",
          "oauthGrant.oauthClientId as clientId",
          "oauthGrant.scopes as scopes",
          "oauthGrant.createdAt as createdAt",
          "oauthClient.name as clientName",
          "oauthClient.homepageUrl as clientHomepage",
          "oauthClient.isFirstParty as firstParty",
        ])
        .where("oauthGrant.organizationId", "=", c.var.organization.id)
        .where("oauthGrant.userId", "=", c.var.user.id)
        .where("oauthGrant.revokedAt", "is", null)
        .orderBy("oauthGrant.createdAt", "desc")
        .execute()

      const data = []
      for (const grant of grants) {
        // eslint-disable-next-line no-await-in-loop -- a person has a handful of grants, and the
        // alternative is one query returning a join this then has to regroup by hand.
        const services = await servicesOf(grant.id)
        data.push({
          id: grant.id,
          clientId: grant.clientId,
          clientName: grant.clientName,
          clientHomepage: grant.clientHomepage,
          firstParty: grant.firstParty,
          scopes: grant.scopes,
          createdAt: grant.createdAt.toISOString(),
          services: services.map((service) => ({
            id: service.id,
            name: service.name,
            kind: service.kind,
            status: service.status,
            createdAt: service.createdAt.toISOString(),
          })),
        })
      }

      return c.json({ data })
    },
  )
  .post(
    "/:orgSlug/oauth-grants/:grantId/revoke",
    describeRoute({
      description: "Withdraws consent, and disposes of every database the application created",
      responses: {
        200: {
          description: "Revoked. Kept databases carry a new URI, shown once",
          content: { "application/json": { schema: resolver(oauthGrantsSchemaRevokeResponse) } },
        },
        400: {
          description: "A database the application created was not accounted for",
          ...errorResponse,
        },
        404: { description: "No such grant for this user", ...errorResponse },
      },
    }),
    // Membership, for the same reason as the listing: a grant is the caller's own.
    requireMembership(),
    validator("param", grantParam),
    validator("json", oauthGrantsSchemaRevokeRequest),
    async (c) => {
      const { grantId } = c.req.valid("param")
      const body = c.req.valid("json")

      const grant = await liveGrant(c.var.organization.id, c.var.user.id, grantId)
      if (grant === undefined) return throwNotFound(c, "Grant not found")

      const services = await servicesOf(grantId)
      const decided = new Map(body.services.map((entry) => [entry.id, entry.action]))

      /*
        Every database has to be accounted for, in both directions.

        A missing one is refused rather than defaulted, because both defaults are irreversible in a
        way the user did not ask for: deleting loses data, keeping leaves them paying for something
        they may not want. A client that has drifted from the list — because a database was created
        between the screen loading and the button being pressed — must be told rather than have one
        of its two wrong answers picked for it.
      */
      const missing = services.filter((service) => !decided.has(service.id))
      if (missing.length > 0) {
        return throwBadRequest(
          c,
          `Decide what happens to ${missing.map((s) => s.name).join(", ")} before revoking. ` +
            `Reload the application's page — this list has changed since it was shown.`,
        )
      }

      const unknown = body.services.filter(
        (entry) => !services.some((service) => service.id === entry.id),
      )
      if (unknown.length > 0) {
        return throwBadRequest(c, "That request names a database this application did not create")
      }

      const kept: {
        id: string
        name: string
        kind: string
        connectionUri: string
        keyPrefix?: string
      }[] = []
      const deleted: { id: string; name: string; kind: string }[] = []

      for (const service of services) {
        if (decided.get(service.id) === "delete") {
          // eslint-disable-next-line no-await-in-loop -- destroying is a per-service driver call
          await driverFor(service.kind).destroy(service.id)
          // eslint-disable-next-line no-await-in-loop
          await db
            .updateTable("backendService")
            .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
            .where("id", "=", service.id)
            .execute()
          deleted.push({ id: service.id, name: service.name, kind: service.kind })
          continue
        }

        /*
          Kept means rotated, not left alone.

          The application minted the only credential this database has, so leaving it would hand the
          user a database the application they just cut off can still reach. Rotation revokes the old
          secret and issues one with no grant on it — the user's own — which is the same operation as
          the rotate button on the Databases page and has the same consequence: anything still using
          the old URI stops working now.
        */
        // eslint-disable-next-line no-await-in-loop
        const result = await driverFor(service.kind).rotateCredentials(service.id)
        // eslint-disable-next-line no-await-in-loop
        await db
          .updateTable("backendService")
          .set({ createdByOauthGrantId: null, updatedAt: new Date() })
          .where("id", "=", service.id)
          .execute()
        kept.push({
          id: service.id,
          name: service.name,
          kind: service.kind,
          connectionUri: result.connectionUri,
          ...(result.keyPrefix === undefined ? {} : { keyPrefix: result.keyPrefix }),
        })
      }

      /*
        The grant last, after the databases are dealt with.

        If disposing of one fails, the grant is still live and the screen can be retried — the
        alternative order revokes consent and then fails, leaving an application cut off from an API
        it can no longer call while still holding a credential to a database nobody can now find,
        because the listing walks from the grant.
      */
      const revokedAt = new Date()
      await db
        .updateTable("oauthGrant")
        .set({ revokedAt, updatedAt: revokedAt })
        .where("id", "=", grantId)
        .execute()

      /*
        Tokens too, though `introspect` already refuses any token whose grant is revoked.

        Belt and braces on purpose: that check is one join in one function, and a second reader of
        `oauth_access_token` that forgot it would resurrect every token this grant ever issued. The
        column is what makes the state readable without knowing about the join.
      */
      await db
        .updateTable("oauthAccessToken")
        .set({ revokedAt })
        .where("oauthGrantId", "=", grantId)
        .where("revokedAt", "is", null)
        .execute()

      await db
        .updateTable("oauthRefreshToken")
        .set({ revokedAt })
        .where("oauthGrantId", "=", grantId)
        .where("revokedAt", "is", null)
        .execute()

      /*
        And every credential the grant minted, including on databases that were deleted.

        Rotation above already revoked the ones on kept services. This catches anything else the
        application holds — and it is the line that makes every proxy enforce this, because
        `lib/rust/service-credentials` filters on `revoked_at` and all three splits go through it.
        No proxy needed changing.
      */
      await db
        .updateTable("serviceCredential")
        .set({ revokedAt })
        .where("oauthGrantId", "=", grantId)
        .where("revokedAt", "is", null)
        .execute()

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "oauth:grant:revoke",
        resourceSrn: srnFor("oauth", c.var.organization.id, "grant", grantId),
        after: {
          clientId: grant.oauthClientId,
          kept: kept.map((s) => s.id),
          deleted: deleted.map((s) => s.id),
        },
        ...auditContext(c),
      })

      return c.json({ kept, deleted })
    },
  )

export default routes
