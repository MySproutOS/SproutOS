import { Type } from "typebox"
import { Nullable } from "../utils/common.serializer"

/**
 * The token endpoint speaks `application/x-www-form-urlencoded` and snake_case, because RFC 6749
 * says so and every OAuth client library in existence assumes it. This is the one place in the API
 * that does not follow the house style, and following it here would break every client.
 */
export const oauthSchemaTokenRequest = Type.Object({
  grant_type: Type.Union([Type.Literal("authorization_code"), Type.Literal("refresh_token")]),
  client_id: Type.String({ minLength: 1 }),
  client_secret: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  redirect_uri: Type.Optional(Type.String()),
  code_verifier: Type.Optional(Type.String()),
  refresh_token: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
})

export const oauthSchemaTokenResponse = Type.Object({
  access_token: Type.String(),
  token_type: Type.Literal("Bearer"),
  expires_in: Type.Number(),
  refresh_token: Type.String(),
  scope: Type.String(),
})

export const oauthSchemaErrorResponse = Type.Object({
  error: Type.String(),
  error_description: Type.String(),
})

/** RFC 7662. `active` is the only field guaranteed present, and the only one that matters. */
export const oauthSchemaIntrospectionResponse = Type.Object({
  active: Type.Boolean(),
  scope: Type.Optional(Type.String()),
  client_id: Type.Optional(Type.String()),
  sub: Type.Optional(Type.String()),
  exp: Type.Optional(Type.Number()),
})

export const oauthSchemaIntrospectRequest = Type.Object({
  token: Type.String({ minLength: 1 }),
  token_type_hint: Type.Optional(Type.String()),
})

export const oauthSchemaRevokeRequest = Type.Object({
  token: Type.String({ minLength: 1 }),
  token_type_hint: Type.Optional(Type.String()),
})

/** RFC 8414 authorization server metadata. */
export const oauthSchemaDiscoveryResponse = Type.Object({
  issuer: Type.String(),
  authorization_endpoint: Type.String(),
  token_endpoint: Type.String(),
  introspection_endpoint: Type.String(),
  revocation_endpoint: Type.String(),
  userinfo_endpoint: Type.String(),
  scopes_supported: Type.Array(Type.String()),
  response_types_supported: Type.Array(Type.String()),
  grant_types_supported: Type.Array(Type.String()),
  code_challenge_methods_supported: Type.Array(Type.String()),
  token_endpoint_auth_methods_supported: Type.Array(Type.String()),
})

export const oauthSchemaUserinfoResponse = Type.Object({
  sub: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  github_user_id: Type.Optional(Type.String()),
  github_login: Type.Optional(Type.String()),
})

export const oauthSchemaConsentRequest = Type.Object({
  clientId: Type.String(),
  redirectUri: Type.String(),
  scopes: Type.Array(Type.String()),
  state: Type.Optional(Nullable(Type.String())),
  codeChallenge: Type.String(),
  codeChallengeMethod: Type.Optional(Type.String()),
  organizationId: Type.String(),
})

export const oauthSchemaConsentResponse = Type.Object({
  redirectTo: Type.String(),
})
