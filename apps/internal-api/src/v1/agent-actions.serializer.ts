import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const agentActionSchemaParam = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 63 }),
  projectId: UUID7String,
})

export const agentActionSchemaSetGroupPrimaryRequest = Type.Object({
  primaryProjectSlug: Type.String({ minLength: 1, maxLength: 63 }),
})

export const agentActionSchemaSetGroupPrimaryResponse = Type.Object({
  action: Type.Literal("set_group_primary_project"),
  groupProjectId: UUID7String,
  groupName: Type.String(),
  primaryProjectId: UUID7String,
  primaryProjectName: Type.String(),
  primaryHostname: Nullable(Type.String()),
  primaryUrl: Nullable(Type.String()),
})
