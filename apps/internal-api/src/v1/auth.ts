import { InactiveGrantError, issueKey, revokeKey } from "@lib/api-keys"
import { fetchOrganization } from "@lib/dao"
import {
  OAuthError,
  redeemAuthorizationCode,
  revokeToken,
  SPROUT_CLI_CLIENT_ID,
} from "@lib/oauth-provider"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { deleteCookie } from "hono/cookie"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware, optionalAuthMiddleware } from "../middleware"
import { cookieDomain } from "../utils/env"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest } from "../utils/http-exception"
import { validator } from "../utils/validator"
import {
  authCliTokenSchemaRequest,
  authCliTokenSchemaResponse,
  authMeSchemaResponse,
} from "./auth.serializer"

const app = new Hono()
  .post(
    "/cli/token",
    describeRoute({
      description:
        "Exchange a Sprout CLI PKCE authorization code for an organization-scoped API key",
      responses: {
        201: {
          description: "A scoped API key shown once",
          content: { "application/json": { schema: resolver(authCliTokenSchemaResponse) } },
        },
        400: {
          description: "The code, client, redirect, or verifier is invalid",
          content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
        },
      },
    }),
    validator("json", authCliTokenSchemaRequest),
    async (c) => {
      const body = c.req.valid("json")
      if (body.clientId !== SPROUT_CLI_CLIENT_ID) {
        return throwBadRequest(c, "The authorization code is not valid", ErrorCode.InvalidInput)
      }

      try {
        const redeemed = await redeemAuthorizationCode(db, {
          code: body.code,
          oauthClientId: body.clientId,
          redirectUri: body.redirectUri,
          codeVerifier: body.codeVerifier,
        })
        const organization = await fetchOrganization(db).getOne(redeemed.organizationId, [
          "id",
          "slug",
        ])
        if (organization === undefined) {
          return throwBadRequest(c, "The authorization code is not valid", ErrorCode.InvalidInput)
        }

        const issued = await issueKey(db, {
          organizationId: organization.id,
          userId: redeemed.userId,
          name: "Sprout CLI",
          scopes: redeemed.scopes,
          oauthGrantId: redeemed.oauthGrantId,
        })

        // This response contains the only copy of a long-lived credential. RFC 6749's token
        // response cache prohibition applies for the same reason even though this is the CLI's
        // specialized exchange endpoint.
        c.header("Cache-Control", "no-store")
        c.header("Pragma", "no-cache")

        return c.json(
          {
            key: issued.key,
            scopes: redeemed.scopes,
            expiresAt: null,
            organization,
          },
          201,
        )
      } catch (error) {
        if (error instanceof OAuthError || error instanceof InactiveGrantError) {
          return throwBadRequest(c, "The authorization code is not valid", ErrorCode.InvalidInput)
        }
        throw error
      }
    },
  )
  .get(
    "/me",
    optionalAuthMiddleware,
    describeRoute({
      security: [{}, { bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        200: {
          description: "Current authenticated user or null",
          content: {
            "application/json": {
              schema: resolver(authMeSchemaResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const user = c.var.user
      const auth = c.var.auth
      const organization =
        auth === null || auth.kind === "session"
          ? null
          : ((await fetchOrganization(db).getOne(auth.organizationId, ["id", "slug"])) ?? null)
      return c.json(
        {
          user: user ?? null,
          organization,
          authentication: auth === null ? null : { kind: auth.kind, scopes: auth.scopes ?? null },
        },
        200,
      )
    },
  )
  .use(authMiddleware)
  .post(
    "/logout",
    describeRoute({
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        200: {
          description: "Successfully logged out",
          content: {
            "application/json": {
              schema: resolver(EmptyObject),
            },
          },
        },
        500: {
          description: "Logout failed",
          content: {
            "application/json": {
              schema: resolver(ErrorSchemaResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const auth = c.var.auth
      const session = c.var.session
      if (auth.kind === "api_key") {
        await revokeKey(db, auth.organizationId, auth.apiKeyId)
        return c.json({}, 200)
      }
      if (auth.kind === "oauth") {
        const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
        if (token !== undefined) await revokeToken(db, token)
        return c.json({}, 200)
      }
      if (session === null) return c.json({}, 200)
      await db.deleteFrom("session").where("sessionKey", "=", session.sessionKey).execute()
      // Domain must match the one the website set the cookie with, or it survives logout.
      deleteCookie(c, "session", { path: "/", domain: cookieDomain() })
      return c.json({}, 200)
    },
  )
  .post(
    "/cli/revoke",
    describeRoute({
      description: "Revoke the Sprout CLI API key presented as a bearer credential",
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "The current CLI key was revoked",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: {
          description: "The bearer credential is not a CLI API key",
          content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
        },
      },
    }),
    async (c) => {
      const auth = c.var.auth
      if (auth.kind !== "api_key") {
        return throwBadRequest(c, "Only an API key can be revoked through this endpoint")
      }
      await revokeKey(db, auth.organizationId, auth.apiKeyId)
      return c.json({}, 200)
    },
  )

export default app
