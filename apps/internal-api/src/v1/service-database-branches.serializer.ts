import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const serviceDatabaseBranchesSchemaParam = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 63 }),
  serviceId: UUID7String,
})

export const serviceDatabaseBranchSchemaParam = Type.Intersect([
  serviceDatabaseBranchesSchemaParam,
  Type.Object({ databaseBranchId: UUID7String }),
])

export const serviceDatabaseBranchSchemaRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 63, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" }),
  parentDatabaseBranchId: UUID7String,
})

export const serviceDatabaseBranchSchema = Type.Object({
  id: UUID7String,
  name: Type.String(),
  kind: Type.String(),
  parentDatabaseBranchId: Nullable(UUID7String),
  isProtected: Type.Boolean(),
  status: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
})

export const serviceDatabaseBranchesSchemaResponse = Type.Object({
  data: Type.Array(serviceDatabaseBranchSchema),
})

export const serviceDatabaseBranchSchemaResponse = Type.Intersect([
  serviceDatabaseBranchSchema,
  Type.Object({ connectionUri: Type.String() }),
])

export const serviceDatabaseBranchConnectionSchemaResponse = Type.Object({
  id: UUID7String,
  connectionUri: Type.String(),
})
