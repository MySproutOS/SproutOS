import { Type } from "typebox"
import { UUID7String } from "../utils/common.serializer"

export const agentDatabaseBranchSchemaParam = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 63 }),
  projectId: UUID7String,
})

export const agentDatabaseBranchSchemaDeleteParam = Type.Intersect([
  agentDatabaseBranchSchemaParam,
  Type.Object({ databaseBranchId: UUID7String }),
])

export const agentDatabaseBranchSchemaRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 31, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" }),
})

export const agentDatabaseBranchSchemaResponse = Type.Object({
  databaseBranchId: UUID7String,
  name: Type.String(),
  databaseUrl: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
})
