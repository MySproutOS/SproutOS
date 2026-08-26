import { crudOauthClient, fetchOauthClient } from "@lib/dao"
import { generateClientSecret, hashClientSecret } from "@lib/oauth-provider"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { collectionResource, paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { validator } from "../utils/validator"
import {
  oauthClientsSchemaClientParam,
  oauthClientsSchemaCreateRequest,
  oauthClientsSchemaCreateResponse,
  oauthClientsSchemaGetResponse,
  oauthClientsSchemaListResponse,
  oauthClientsSchemaOrgParam,
  oauthClientsSchemaSecretListResponse,
  oauthClientsSchemaSecretParam,
  oauthClientsSchemaSecretResponse,
  oauthClientsSchemaStatusRequest,
  oauthClientsSchemaUpdateRequest,
} from "./oauth-clients.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * Registering an application against SproutOS's OAuth provider.
 *
 * The provider itself has existed for a while — `/oauth/consent`, `/oauth/token`, introspection and
 * revocation are all in `oauth.ts`, and `oauth-bearer.ts` is the resource-server side. What was
 * missing was any way for a developer to *get a client*: the only `insertInto("oauthClient")` in the
 * repository was in tests, and the single real client was hand-seeded in a migration. A provider
 * nobody can register with is a provider with one first-party client.
 *
 * This is that surface. It is deliberately owned by an organization rather than a user: a client
 * outlives the person who created it, and a developer leaving should not take an integration's
 * credentials with them.
 */
const app: Hono = new Hono()
app.use(authMiddleware)

async function present(row: {
  id: string
  name: string
  description: string | null
  logoUrl: string | null
  homepageUrl: string
  clientType: string
  isFirstParty: boolean
  isVerified: boolean
  status: string
  defaultScopes: string[]
  createdAt: Date
}) {
  return {
    ...row,
    defaultScopes: row.defaultScopes ?? [],
    createdAt: row.createdAt.toISOString(),
    redirectUris: await fetchOauthClient(db).listRedirectUris(row.id),
  }
}

const CLIENT_FIELDS = [
  "id",
  "name",
  "description",
  "logoUrl",
  "homepageUrl",
  "clientType",
  "isFirstParty",
  "isVerified",
  "status",
  "defaultScopes",
  "createdAt",
] as const

app
  .get(
    "/:orgSlug/oauth-clients",
    describeRoute({
      description: "OAuth applications this organization has registered",
      responses: {
        200: {
          description: "Clients",
          content: { "application/json": { schema: resolver(oauthClientsSchemaListResponse) } },
        },
        403: { description: "Caller lacks oauth_client:read", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:read", collectionResource("oauth", "oauth_client")),
    validator("param", oauthClientsSchemaOrgParam),
    async (c) => {
      const rows = await fetchOauthClient(db).listForOrganization(c.var.organization.id, [
        ...CLIENT_FIELDS,
      ])
      return c.json({ items: await Promise.all(rows.map(present)) })
    },
  )
  .post(
    "/:orgSlug/oauth-clients",
    describeRoute({
      description:
        "Register an OAuth application. Returns the secret once for confidential clients.",
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: resolver(oauthClientsSchemaCreateResponse) } },
        },
        403: { description: "Caller lacks oauth_client:create", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:create", collectionResource("oauth", "oauth_client")),
    validator("param", oauthClientsSchemaOrgParam),
    validator("json", oauthClientsSchemaCreateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const id = v7()

      await crudOauthClient(db).createClient(
        {
          id,
          ownerUserId: c.var.user.id,
          organizationId: c.var.organization.id,
          name: body.name,
          description: body.description ?? null,
          logoUrl: body.logoUrl ?? null,
          homepageUrl: body.homepageUrl,
          clientType: body.clientType,
          defaultScopes: body.defaultScopes ?? [],
        },
        body.redirectUris,
      )

      /*
        A public client gets no secret, and this is the one place that has to be right.

        Issuing one "just in case" would put a credential into a single-page app or a mobile binary,
        where it ships to every user and is therefore not a secret at all. The absence is what forces
        PKCE, which is the thing that actually protects a public client.
      */
      let secret: { id: string; secret: string; lastFour: string } | undefined
      if (body.clientType === "confidential") {
        const value = generateClientSecret()
        const created = await crudOauthClient(db).addSecret({
          oauthClientId: id,
          secretHash: await hashClientSecret(value),
          lastFour: value.slice(-4),
        })
        secret = { id: created.id, secret: value, lastFour: value.slice(-4) }
      }

      const row = await fetchOauthClient(db).getInOrganization(c.var.organization.id, id, [
        ...CLIENT_FIELDS,
      ])
      if (row === undefined) return throwNotFound(c, "Client")

      return c.json({ ...(await present(row)), ...(secret === undefined ? {} : { secret }) }, 201)
    },
  )
  .get(
    "/:orgSlug/oauth-clients/:clientId",
    describeRoute({
      description: "One OAuth application",
      responses: {
        200: {
          description: "Client",
          content: { "application/json": { schema: resolver(oauthClientsSchemaGetResponse) } },
        },
        404: { description: "No such client in this organization", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:read", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaClientParam),
    async (c) => {
      const row = await fetchOauthClient(db).getInOrganization(
        c.var.organization.id,
        c.req.valid("param").clientId,
        [...CLIENT_FIELDS],
      )
      if (row === undefined) return throwNotFound(c, "Client")
      return c.json(await present(row))
    },
  )
  .patch(
    "/:orgSlug/oauth-clients/:clientId",
    describeRoute({
      description: "Update an OAuth application. Redirect URIs are replaced wholesale.",
      responses: {
        200: { description: "Updated" },
        404: { description: "No such client in this organization", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:update", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaClientParam),
    validator("json", oauthClientsSchemaUpdateRequest),
    async (c) => {
      const { clientId } = c.req.valid("param")
      const body = c.req.valid("json")
      const organizationId = c.var.organization.id

      const { redirectUris, ...rest } = body

      if (Object.keys(rest).length > 0) {
        const updated = await crudOauthClient(db).updateClient(organizationId, clientId, rest)
        if (!updated) return throwNotFound(c, "Client")
      }

      if (redirectUris !== undefined) {
        const replaced = await crudOauthClient(db).replaceRedirectUris(
          organizationId,
          clientId,
          redirectUris,
        )
        if (!replaced) return throwNotFound(c, "Client")
      }

      const row = await fetchOauthClient(db).getInOrganization(organizationId, clientId, [
        ...CLIENT_FIELDS,
      ])
      if (row === undefined) return throwNotFound(c, "Client")
      return c.json(await present(row))
    },
  )
  .put(
    "/:orgSlug/oauth-clients/:clientId/status",
    describeRoute({
      description: "Suspend or reactivate a client. Suspended clients cannot obtain tokens.",
      responses: {
        200: { description: "Updated" },
        404: { description: "No such client in this organization", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:update", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaClientParam),
    validator("json", oauthClientsSchemaStatusRequest),
    async (c) => {
      const { clientId } = c.req.valid("param")
      const changed = await crudOauthClient(db).setStatus(
        c.var.organization.id,
        clientId,
        c.req.valid("json").status,
      )
      if (!changed) return throwNotFound(c, "Client")
      return c.json({ ok: true })
    },
  )
  .get(
    "/:orgSlug/oauth-clients/:clientId/secrets",
    describeRoute({
      description: "A client's secrets, without the secrets.",
      responses: {
        200: {
          description: "Secrets",
          content: {
            "application/json": { schema: resolver(oauthClientsSchemaSecretListResponse) },
          },
        },
      },
    }),
    requirePermission("oauth_client:read", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaClientParam),
    async (c) => {
      const { clientId } = c.req.valid("param")
      const owned = await fetchOauthClient(db).getInOrganization(c.var.organization.id, clientId, [
        "id",
      ])
      if (owned === undefined) return throwNotFound(c, "Client")

      const rows = await fetchOauthClient(db).listSecrets(clientId)
      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          lastFour: row.lastFour,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        })),
      })
    },
  )
  .post(
    "/:orgSlug/oauth-clients/:clientId/secrets",
    describeRoute({
      description: "Issue an additional secret. Shown once and never again.",
      responses: {
        201: {
          description: "The new secret",
          content: { "application/json": { schema: resolver(oauthClientsSchemaSecretResponse) } },
        },
        400: { description: "Public clients have no secret", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:update", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaClientParam),
    async (c) => {
      const { clientId } = c.req.valid("param")
      const owned = await fetchOauthClient(db).getInOrganization(c.var.organization.id, clientId, [
        "id",
        "clientType",
      ])
      if (owned === undefined) return throwNotFound(c, "Client")

      if (owned.clientType !== "confidential") {
        return throwBadRequest(c, "A public client authenticates with PKCE and has no secret")
      }

      /*
        Additional rather than replacing, which is what makes rotation possible without downtime.

        The developer issues a second secret, deploys it, confirms traffic is using it, and revokes
        the first. A rotate-in-place endpoint would break every running instance of their app at the
        moment they clicked it.
      */
      const value = generateClientSecret()
      const created = await crudOauthClient(db).addSecret({
        oauthClientId: clientId,
        secretHash: await hashClientSecret(value),
        lastFour: value.slice(-4),
      })

      return c.json(
        {
          id: created.id,
          secret: value,
          lastFour: value.slice(-4),
          createdAt: new Date().toISOString(),
        },
        201,
      )
    },
  )
  .delete(
    "/:orgSlug/oauth-clients/:clientId/secrets/:secretId",
    describeRoute({
      description: "Revoke a secret. The record is kept; the secret stops working.",
      responses: {
        200: { description: "Revoked" },
        404: { description: "No such secret on this client", ...errorResponse },
      },
    }),
    requirePermission("oauth_client:update", paramResource("oauth", "oauth_client", "clientId")),
    validator("param", oauthClientsSchemaSecretParam),
    async (c) => {
      const { clientId, secretId } = c.req.valid("param")
      const owned = await fetchOauthClient(db).getInOrganization(c.var.organization.id, clientId, [
        "id",
      ])
      if (owned === undefined) return throwNotFound(c, "Client")

      const revoked = await crudOauthClient(db).revokeSecret(clientId, secretId)
      if (!revoked) return throwNotFound(c, "Secret")
      return c.json({ ok: true })
    },
  )

export default app
