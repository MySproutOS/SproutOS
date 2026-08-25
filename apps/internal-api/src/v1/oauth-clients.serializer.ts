import { Type } from "typebox"
import { Nullable } from "../utils/common.serializer"

/**
 * A redirect URI, checked here rather than only at the authorization endpoint.
 *
 * This is where the authorization code is delivered, so a loose one is not a validation nicety —
 * it is the difference between a code reaching the developer and reaching whoever registered a
 * lookalike. Three rules, and each is a real attack:
 *
 * - **Absolute, with a scheme.** A relative URI resolves against whatever origin is current.
 * - **No fragment.** The fragment is not sent to the server, and a client that put state there is
 *   a client whose state can be rewritten by the browser.
 * - **HTTPS, or localhost.** `http://` anywhere else means the code crosses the network in clear.
 *   Localhost is the documented exception, because a native app's loopback listener has no
 *   certificate and never leaves the machine.
 */
const RedirectUri = Type.String({
  minLength: 1,
  maxLength: 2000,
  pattern: "^(https://[^#\\s]+|http://(localhost|127\\.0\\.0\\.1)(:\\d+)?(/[^#\\s]*)?)$",
})

export const oauthClientsSchemaOrgParam = Type.Object({ orgSlug: Type.String({ minLength: 1 }) })

export const oauthClientsSchemaClientParam = Type.Object({
  orgSlug: Type.String({ minLength: 1 }),
  clientId: Type.String({ format: "uuid" }),
})

export const oauthClientsSchemaSecretParam = Type.Object({
  orgSlug: Type.String({ minLength: 1 }),
  clientId: Type.String({ format: "uuid" }),
  secretId: Type.String({ format: "uuid" }),
})

export const oauthClientsSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  homepageUrl: Type.String({ minLength: 1, maxLength: 2000 }),
  /**
   * `public` clients get no secret and must use PKCE.
   *
   * Named by the developer rather than inferred, because the platform cannot tell a server-side app
   * from a single-page one, and guessing wrong in the permissive direction hands a secret to
   * something that ships its own source.
   */
  clientType: Type.Union([Type.Literal("confidential"), Type.Literal("public")]),
  redirectUris: Type.Array(RedirectUri, { minItems: 1, maxItems: 10 }),
  description: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
  logoUrl: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  defaultScopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
})

export const oauthClientsSchemaUpdateRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  homepageUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  description: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
  logoUrl: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  redirectUris: Type.Optional(Type.Array(RedirectUri, { minItems: 1, maxItems: 10 })),
  defaultScopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
})

export const oauthClientsSchemaStatusRequest = Type.Object({
  status: Type.Union([Type.Literal("active"), Type.Literal("suspended")]),
})

const OauthClient = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Nullable(Type.String()),
  logoUrl: Nullable(Type.String()),
  homepageUrl: Type.String(),
  clientType: Type.String(),
  /**
   * Whether SproutOS vouches for this client, shown on the consent screen.
   *
   * Self-registered clients are `false` and must stay that way — a developer who could set it would
   * be able to make their own app look like ours on the screen where a user decides whether to
   * trust it. Nothing in this file writes either flag.
   */
  isFirstParty: Type.Boolean(),
  isVerified: Type.Boolean(),
  status: Type.String(),
  defaultScopes: Type.Array(Type.String()),
  redirectUris: Type.Array(Type.String()),
  createdAt: Type.String(),
})

export const oauthClientsSchemaListResponse = Type.Object({ items: Type.Array(OauthClient) })
export const oauthClientsSchemaGetResponse = OauthClient

/**
 * The only response that ever carries a secret, and only at the moment it is created.
 *
 * There is no endpoint that returns it again, because only its hash is stored. That is not a
 * limitation to apologise for in the docs — it is what makes a leaked database useless for
 * impersonating a client.
 */
export const oauthClientsSchemaSecretResponse = Type.Object({
  id: Type.String(),
  secret: Type.String({ description: "Shown once. It cannot be retrieved again." }),
  lastFour: Type.String(),
  createdAt: Type.String(),
})

export const oauthClientsSchemaSecretListResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      lastFour: Type.String(),
      createdAt: Type.String(),
      expiresAt: Nullable(Type.String()),
      revokedAt: Nullable(Type.String()),
      lastUsedAt: Nullable(Type.String()),
    }),
  ),
})
