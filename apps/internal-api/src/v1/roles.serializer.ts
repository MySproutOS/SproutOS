import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const roleSlugParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
})

export const roleIdParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
  roleId: UUID7String,
})

const statementSchema = Type.Object({
  effect: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  actions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    minItems: 1,
    maxItems: 200,
  }),
  resources: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 200,
  }),
})

export const roleSchemaListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      name: Type.String(),
      description: Nullable(Type.String()),
      isSystem: Type.Boolean(),
      statements: Type.Array(
        Type.Object({
          id: UUID7String,
          effect: Type.String(),
          actions: Type.Array(Type.String()),
          resources: Type.Array(Type.String()),
        }),
      ),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
})

export const roleSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
  statements: Type.Array(statementSchema, { minItems: 1, maxItems: 50 }),
})

export const roleSchemaCreateResponse = Type.Object({
  id: UUID7String,
  name: Type.String(),
})

export const roleSchemaUpdateRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  description: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
  statements: Type.Optional(Type.Array(statementSchema, { minItems: 1, maxItems: 50 })),
})

export const roleSchemaActionsResponse = Type.Object({
  data: Type.Array(Type.String()),
})
