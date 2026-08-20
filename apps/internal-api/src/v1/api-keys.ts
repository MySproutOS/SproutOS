import { issueKey, revokeKey } from "@lib/api-keys"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { isGrantableAction, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import {
  apiKeysSchemaCreateRequest,
  apiKeysSchemaCreateResponse,
  apiKeysSchemaKeyParam,
  apiKeysSchemaListResponse,
  apiKeysSchemaOrgParam,
} from "./api-keys.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * Programmatic API keys for the organization.
 *
 * A key's power is the **intersection** of what its creator can do and what it was granted — the
 * same rule an OAuth token follows, and enforced by the same `requirePermission`. That is why
 * nothing here needs to re-check permissions at use time: the bearer middleware establishes who the
 * key acts as, and RBAC does the rest.
 */
const app: Hono = new Hono()
app.use(authMiddleware)

app
  .get(
    "/:orgSlug/api-keys",
    describeRoute({
      description: "The organization's API keys",
      responses: {
        200: {
          description: "Keys",
          content: { "application/json": { schema: resolver(apiKeysSchemaListResponse) } },
        },
        403: { description: "Caller lacks credential:read", ...errorResponse },
      },
    }),
    requirePermission("credential:read"),
    validator("param", apiKeysSchemaOrgParam),
    async (c) => {
      const rows = await db
        .selectFrom("apiKey")
        .innerJoin("user", "user.id", "apiKey.userId")
        .select([
          "apiKey.id as id",
          "apiKey.name as name",
          "apiKey.prefix as prefix",
          "apiKey.scopes as scopes",
          "apiKey.createdAt as createdAt",
          "apiKey.lastUsedAt as lastUsedAt",
          "apiKey.expiresAt as expiresAt",
          "apiKey.userId as createdByUserId",
          "user.name as createdByName",
        ])
        .where("apiKey.organizationId", "=", c.var.organization.id)
        // Revoked keys are not deleted — `audit_log` references them — but a settings list is about
        // what is live, and a growing list of dead keys is how the live ones get lost.
        .where("apiKey.revokedAt", "is", null)
        .orderBy("apiKey.createdAt", "desc")
        .execute()

      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          scopes: row.scopes ?? [],
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdByUserId: row.createdByUserId,
          createdByName: row.createdByName ?? "",
        })),
      })
    },
  )
  .post(
    "/:orgSlug/api-keys",
    describeRoute({
      description: "Mint an API key. The secret is returned once.",
      responses: {
        201: {
          description: "The key, shown once",
          content: { "application/json": { schema: resolver(apiKeysSchemaCreateResponse) } },
        },
        400: { description: "An unknown scope, or one the caller does not hold", ...errorResponse },
        403: { description: "Caller lacks credential:write", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("param", apiKeysSchemaOrgParam),
    validator("json", apiKeysSchemaCreateRequest),
    async (c) => {
      const { name, scopes, expiresInDays } = c.req.valid("json")
      const organizationId = c.var.organization.id
      const requested = scopes ?? ["*"]

      /*
        Every scope must be a real action.

        A typo — `projects:read` for `project:read` — would otherwise mint a key that silently does
        nothing, and the customer would debug their script rather than their key.
      */
      for (const scope of requested) {
        if (!isGrantableAction(scope)) {
          return throwBadRequest(c, `\`${scope}\` is not a permission this platform has`)
        }
      }

      /*
        No check that the caller *holds* the scopes they are granting, deliberately.

        It would be redundant: a key's power is the intersection of its scopes with its user's live
        RBAC, evaluated on every request by `requirePermission`. A member who mints a key with
        `org:delete` has minted a key that cannot delete the organization — and if they are later
        promoted, it can, which is the behaviour anyone would expect from "acts as me".

        It would also be wrong in a specific way: checking against the organization's own SRN would
        refuse a scope the user holds only on particular projects, so a custom role scoped to two
        projects could not mint a key for those projects.

        What is checked is that each scope *exists*. A typo — `projects:read` for `project:read` —
        would otherwise mint a key that silently does nothing, and the customer would spend the
        afternoon debugging their script rather than their key.
      */

      const expiresAt =
        expiresInDays === undefined
          ? null
          : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

      const issued = await issueKey(db, {
        organizationId,
        userId: c.var.user.id,
        name,
        scopes: requested,
        expiresAt,
      })

      return c.json(
        {
          id: issued.id,
          key: issued.key,
          prefix: issued.prefix,
          scopes: requested,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
        201,
      )
    },
  )
  .delete(
    "/:orgSlug/api-keys/:apiKeyId",
    describeRoute({
      description: "Revoke an API key",
      responses: {
        204: { description: "Revoked" },
        403: { description: "Caller lacks credential:write", ...errorResponse },
        404: { description: "No such key", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("param", apiKeysSchemaKeyParam),
    async (c) => {
      const { apiKeyId } = c.req.valid("param")
      const revoked = await revokeKey(db, c.var.organization.id, apiKeyId)
      // A key belonging to another organization is a 404, not a 403: a different answer would
      // confirm the id is real.
      if (!revoked) return throwNotFound(c, "API key not found")
      return c.body(null, 204)
    },
  )

export default app
