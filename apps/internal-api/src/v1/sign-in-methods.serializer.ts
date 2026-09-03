import { Type } from "typebox"
import { UUID7String } from "../utils/common.serializer"

export const signInMethodSchemaProvider = Type.Union([
  Type.Literal("google"),
  Type.Literal("github"),
])

export const signInMethodSchemaListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      provider: signInMethodSchemaProvider,
      displayIdentity: Type.String(),
      connectedAt: Type.String({ format: "date-time" }),
      repositoryAccessNeedsReauthorization: Type.Boolean(),
      canUnlink: Type.Boolean(),
    }),
  ),
})

export const signInMethodSchemaAuthorizeRequest = Type.Object({
  provider: signInMethodSchemaProvider,
  intent: Type.Union([Type.Literal("link"), Type.Literal("reauthorize")]),
  methodId: Type.Optional(UUID7String),
  returnTo: Type.String({ minLength: 1, maxLength: 1_024 }),
})

export const signInMethodSchemaAuthorizeResponse = Type.Object({
  authorizationUrl: Type.String({ format: "uri" }),
})

export const signInMethodSchemaParam = Type.Object({ methodId: UUID7String })

export const signInMethodSchemaUnlinkRequest = Type.Object({
  confirmation: Type.Literal("UNLINK"),
})
