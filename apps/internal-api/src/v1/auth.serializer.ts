import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const authCliTokenSchemaRequest = Type.Object({
  code: Type.String({ minLength: 1 }),
  clientId: UUID7String,
  redirectUri: Type.String({ minLength: 1 }),
  codeVerifier: Type.String({ minLength: 43, maxLength: 128 }),
})

export const authCliTokenSchemaResponse = Type.Object({
  key: Type.String(),
  scopes: Type.Array(Type.String()),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
  organization: Type.Object({ id: UUID7String, slug: Type.String() }),
})

export const authMeSchemaResponse = Type.Object({
  user: Nullable(
    Type.Object({
      id: UUID7String,
      name: Nullable(Type.String()),
      email: Type.String(),
      isAdmin: Type.Boolean(),
    }),
  ),
  organization: Nullable(Type.Object({ id: UUID7String, slug: Type.String() })),
  authentication: Nullable(
    Type.Object({
      kind: Type.Union([Type.Literal("session"), Type.Literal("oauth"), Type.Literal("api_key")]),
      scopes: Nullable(Type.Array(Type.String())),
    }),
  ),
})
