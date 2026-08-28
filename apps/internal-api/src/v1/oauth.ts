import { crudAuditLog } from "@lib/dao"
import {
  assertRegisteredRedirect,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  hashClientSecret,
  introspect,
  OAuthError,
  revokeToken,
  rotateRefreshToken,
} from "@lib/oauth-provider"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { type Context, Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { validate as validateUUID, v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { ACTIONS, isGrantableAction } from "../rbac"
import { auditContext } from "../utils/request-context"
import {
  oauthSchemaConsentRequest,
  oauthSchemaConsentResponse,
  oauthSchemaDiscoveryResponse,
  oauthSchemaErrorResponse,
  oauthSchemaIntrospectionResponse,
  oauthSchemaIntrospectRequest,
  oauthSchemaRevokeRequest,
  oauthSchemaTokenRequest,
  oauthSchemaTokenResponse,
} from "./oauth.serializer"

/**
 * SproutOS as an OAuth 2.1 authorization server (TASK 6).
 *
 * **Scopes are the RBAC action catalogue**, not a second vocabulary. A token's effective
 * permission is the intersection of what the user can do and what they granted the client, so a
 * scope that is not an action could never be granted by anyone — and inventing a parallel
 * vocabulary means two lists that drift and one of them being wrong.
 */

function issuer(): string {
  return process.env.NEXT_PUBLIC_HOST_URL ?? "http://localhost:3000"
}

/**
 * Where the machine-to-machine endpoints actually live, which is not where the issuer does.
 *
 * The discovery document is the only contract a third-party client has: it reads this and posts
 * its token exchange wherever this says. It said `${issuer}/api/v1/oauth/token`, which is the
 * shape of the upstream template — a Hono API mounted *inside* Next.js. This platform serves the
 * API from its own host, so that URL is not the API at all. In production it answered **307**, a
 * redirect to the login page, meaning any client following discovery correctly would have sent
 * its client secret into an HTML redirect and failed with nothing that named the cause.
 *
 * `issuer` stays the website: it is the identity the tokens are minted under, and
 * `authorization_endpoint` is a page a human visits. Only the endpoints a *client* calls move.
 */
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
}

/**
 * Turn a failure into the shape RFC 6749 §5.2 requires.
 *
 * The code is part of the protocol — a client branches on `invalid_grant` to know its refresh
 * token is dead — and anything unexpected becomes `server_error` with no detail, because an
 * internal message here is an error page for an attacker to read.
 */
function oauthError(c: Context, error: unknown): Response {
  if (error instanceof OAuthError) {
    if (error.status === 401) c.header("WWW-Authenticate", 'Basic realm="oauth"')
    return c.json(error.toJSON(), error.status)
  }
  console.warn("[oauth] unexpected failure", error)
  return c.json(
    { error: "server_error", error_description: "The request could not be completed" },
    500,
  )
}

const app = new Hono()
  .get(
    "/.well-known/oauth-authorization-server",
    describeRoute({
      description: "RFC 8414 authorization server metadata",
      responses: {
        200: {
          description: "Metadata",
          content: { "application/json": { schema: resolver(oauthSchemaDiscoveryResponse) } },
        },
      },
    }),
    (c) => {
      const base = issuer()
      const api = apiBase()
      return c.json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${api}/v1/oauth/token`,
        introspection_endpoint: `${api}/v1/oauth/introspect`,
        revocation_endpoint: `${api}/v1/oauth/revoke`,
        scopes_supported: [...ACTIONS],
        // OAuth 2.1: the implicit grant is gone, so `token` is not a response type we offer.
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // S256 only. `plain` is a challenge equal to the verifier, which is no protection.
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      })
    },
  )
  /**
   * The consent step, called by the authorization page once a signed-in person approves.
   *
   * The page itself lives in the website — it needs a session cookie and a human — and this is
   * what it posts to. Splitting them keeps the authorization *decision* on an authenticated API
   * route rather than in a page handler.
   */
  .post(
    "/consent",
    describeRoute({
      description: "Records consent and mints an authorization code",
      responses: {
        200: {
          description: "Where to send the browser",
          content: { "application/json": { schema: resolver(oauthSchemaConsentResponse) } },
        },
        400: {
          description: "Invalid request",
          content: { "application/json": { schema: resolver(oauthSchemaErrorResponse) } },
        },
      },
    }),
    authMiddleware,
    validator("json", oauthSchemaConsentRequest),
    async (c) => {
      const body = c.req.valid("json")
      const user = c.var.user

      try {
        if ((body.codeChallengeMethod ?? "S256") !== "S256") {
          throw new OAuthError(
            "invalid_request",
            "Only the S256 code challenge method is supported",
          )
        }
        if (body.codeChallenge === "") {
          throw new OAuthError("invalid_request", "code_challenge is required")
        }

        assertClientIdShape(body.clientId)

        const client = await db
          .selectFrom("oauthClient")
          .select(["id", "status", "defaultScopes"])
          .where("id", "=", body.clientId)
          .executeTakeFirst()

        if (client === undefined || client.status !== "active") {
          throw new OAuthError("invalid_client", "Unknown client")
        }

        const registered = await db
          .selectFrom("oauthClientRedirectUri")
          .select("uri")
          .where("oauthClientId", "=", client.id)
          .execute()

        const redirectUri = assertRegisteredRedirect(
          body.redirectUri,
          registered.map((row) => row.uri),
        )

        // A person can only grant what they themselves hold. Checked here rather than at the
        // resource server alone, so a grant never records a permission the user never had.
        const unknown = body.scopes.filter((scope) => !isGrantableAction(scope))
        if (unknown.length > 0) {
          throw new OAuthError("invalid_scope", `Not a known scope: ${unknown.join(", ")}`)
        }

        const membership = await db
          .selectFrom("organizationMember")
          .select("id")
          .where("organizationId", "=", body.organizationId)
          .where("userId", "=", user.id)
          .executeTakeFirst()

        if (membership === undefined) {
          throw new OAuthError("access_denied", "You are not a member of that organization")
        }

        /*
          One live grant per (client, user, organization) — the partial unique index says so.

          Re-consenting replaces the scopes rather than stacking a second grant, so revoking is one
          row and "what has this app got" has one answer.
        */
        const grantId = v7()
        const grant = await db
          .insertInto("oauthGrant")
          .values({
            id: grantId,
            oauthClientId: client.id,
            userId: user.id,
            organizationId: body.organizationId,
            scopes: body.scopes,
          })
          .onConflict((oc) =>
            oc
              .columns(["oauthClientId", "userId", "organizationId"])
              .where("revokedAt", "is", null)
              .doUpdateSet({ scopes: body.scopes, updatedAt: new Date() }),
          )
          .returning("id")
          .executeTakeFirstOrThrow()

        const code = await createAuthorizationCode(db, {
          oauthClientId: client.id,
          userId: user.id,
          organizationId: body.organizationId,
          oauthGrantId: grant.id,
          redirectUri,
          scopes: body.scopes,
          codeChallenge: body.codeChallenge,
        })

        await crudAuditLog(db).record({
          organizationId: body.organizationId,
          actorUserId: user.id,
          action: "apikey:create",
          resourceSrn: srnFor("oauth", body.organizationId, "grant", grant.id),
          after: { clientId: client.id, scopes: body.scopes },
          ...auditContext(c),
        })

        const target = new URL(redirectUri)
        target.searchParams.set("code", code)
        if (body.state != null) target.searchParams.set("state", body.state)

        return c.json({ redirectTo: target.toString() })
      } catch (error) {
        return oauthError(c, error)
      }
    },
  )
  .post(
    "/token",
    describeRoute({
      description: "RFC 6749 token endpoint: authorization_code and refresh_token grants",
      responses: {
        200: {
          description: "Tokens",
          content: { "application/json": { schema: resolver(oauthSchemaTokenResponse) } },
        },
        400: {
          description: "Invalid grant",
          content: { "application/json": { schema: resolver(oauthSchemaErrorResponse) } },
        },
      },
    }),
    validator("form", oauthSchemaTokenRequest),
    async (c) => {
      const body = c.req.valid("form")

      try {
        await authenticateClient(body.client_id, body.client_secret)

        const tokens =
          body.grant_type === "authorization_code"
            ? await exchangeAuthorizationCode(db, {
                code: required(body.code, "code"),
                oauthClientId: body.client_id,
                redirectUri: required(body.redirect_uri, "redirect_uri"),
                codeVerifier: required(body.code_verifier, "code_verifier"),
              })
            : await rotateRefreshToken(db, {
                refreshToken: required(body.refresh_token, "refresh_token"),
                oauthClientId: body.client_id,
                scopes: body.scope?.split(" ").filter((scope) => scope !== ""),
              })

        // RFC 6749 §5.1: token responses must not be cached anywhere.
        c.header("Cache-Control", "no-store")
        c.header("Pragma", "no-cache")

        return c.json({
          access_token: tokens.accessToken,
          token_type: "Bearer" as const,
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scopes.join(" "),
        })
      } catch (error) {
        return oauthError(c, error)
      }
    },
  )
  .post(
    "/introspect",
    describeRoute({
      description: "RFC 7662 introspection. Requires client authentication",
      responses: {
        200: {
          description: "Token state",
          content: {
            "application/json": { schema: resolver(oauthSchemaIntrospectionResponse) },
          },
        },
      },
    }),
    validator("form", oauthSchemaIntrospectRequest),
    async (c) => {
      const clientId = c.req.header("x-client-id")
      const clientSecret = c.req.header("x-client-secret")

      try {
        // Introspection tells the caller whether a token is live and who it belongs to, so an
        // unauthenticated endpoint is an oracle for guessing tokens.
        await authenticateClient(clientId ?? "", clientSecret, { requireSecret: true })

        const result = await introspect(db, c.req.valid("form").token)
        if (!result.active) return c.json({ active: false })

        return c.json({
          active: true,
          scope: result.scopes?.join(" "),
          client_id: result.oauthClientId,
          sub: result.userId,
          exp:
            result.expiresAt === undefined
              ? undefined
              : Math.floor(result.expiresAt.getTime() / 1000),
        })
      } catch (error) {
        return oauthError(c, error)
      }
    },
  )
  .post(
    "/revoke",
    describeRoute({
      description: "RFC 7009 revocation. Always 200, even for an unknown token",
      responses: { 200: { description: "Revoked, or was never valid" } },
    }),
    validator("form", oauthSchemaRevokeRequest),
    async (c) => {
      // RFC 7009 §2.2: an unknown token is a success. Distinguishing it would turn this into an
      // oracle for whether a token exists.
      await revokeToken(db, c.req.valid("form").token).catch(() => undefined)
      return c.body(null, 200)
    },
  )

/**
 * A client id off the wire, checked for shape before it reaches Postgres.
 *
 * `oauth_client.id` is a uuid column, so a lookup with anything else raises `invalid_input_syntax`
 * inside the driver rather than returning no rows. That escaped as `server_error` with a 500,
 * which is wrong three times over: it is a 500 for a request that is simply malformed, it is
 * reachable unauthenticated by anyone who can spell the endpoint, and it tells that caller
 * something — an unknown-but-well-formed id answers `invalid_client`, so the two responses
 * separate "not a uuid" from "not a client".
 *
 * The same error a genuinely unknown client gets, therefore, and for the same reason the rest of
 * this file is careful about: an error that distinguishes cases is an oracle for enumerating them.
 */
function assertClientIdShape(clientId: string, status: 400 | 401 = 400): void {
  if (!validateUUID(clientId)) {
    throw new OAuthError("invalid_client", "Unknown client", status)
  }
}

/**
 * Client authentication.
 *
 * A public client has no secret — that is what "public" means, and OAuth 2.1 relies on PKCE rather
 * than a secret that a native app cannot keep. A confidential client must present one, compared by
 * hash in constant time.
 */
async function authenticateClient(
  clientId: string,
  clientSecret: string | undefined,
  options: { requireSecret?: boolean } = {},
): Promise<void> {
  assertClientIdShape(clientId, 401)

  const client = await db
    .selectFrom("oauthClient")
    .select(["id", "clientType", "status"])
    .where("id", "=", clientId)
    .executeTakeFirst()

  if (client === undefined || client.status !== "active") {
    throw new OAuthError("invalid_client", "Unknown client", 401)
  }

  const needsSecret = client.clientType === "confidential" || options.requireSecret === true
  if (!needsSecret) return

  if (clientSecret === undefined || clientSecret === "") {
    throw new OAuthError("invalid_client", "This client must authenticate", 401)
  }

  // Through the same function that stored it. Hashing inline here is what broke this:
  // `oauth-clients.ts` stores `sha256$<hex>` and this compared a bare `<hex>`, so no
  // confidential client could ever authenticate.
  const secretHash = await hashClientSecret(clientSecret)
  const secrets = await db
    .selectFrom("oauthClientSecret")
    .select("secretHash")
    .where("oauthClientId", "=", client.id)
    .where("revokedAt", "is", null)
    .execute()

  // Constant-time against every live secret, and no early return on the first mismatch: rotation
  // means a client legitimately has two for a while.
  const matched = secrets.some((row) => constantTimeEqualUtf8(row.secretHash, secretHash))
  if (!matched) throw new OAuthError("invalid_client", "Client authentication failed", 401)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new OAuthError("invalid_request", `${name} is required`)
  }
  return value
}

export default app
