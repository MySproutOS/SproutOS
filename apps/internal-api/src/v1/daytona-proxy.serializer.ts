import { Type } from "typebox"
import { UUID7String } from "../utils/common.serializer"

export const daytonaProxyAuthorizeSchemaParam = Type.Object({
  id: UUID7String,
})

export const daytonaProxyAuthorizeSchemaResponse = Type.Object({
  sandboxId: UUID7String,
  projectId: UUID7String,
  organizationId: UUID7String,
  state: Type.Union([Type.Literal("starting"), Type.Literal("running"), Type.Literal("idle")]),
})
