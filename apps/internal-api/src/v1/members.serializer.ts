import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const memberSlugParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
})

export const memberIdParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
  memberId: UUID7String,
})

export const inviteIdParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
  inviteId: UUID7String,
})

export const memberSchemaListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const memberSchemaListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      userId: UUID7String,
      name: Nullable(Type.String()),
      email: Type.String(),
      status: Type.String(),
      isOwner: Type.Boolean(),
      roles: Type.Array(Type.Object({ id: UUID7String, name: Type.String() })),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
  nextCursor: Nullable(Type.String()),
})

export const memberSchemaRolesRequest = Type.Object({
  roleIds: Type.Array(UUID7String, { minItems: 1, maxItems: 20 }),
})

export const inviteSchemaCreateRequest = Type.Object({
  email: Type.String({ format: "email", maxLength: 320 }),
  roleId: UUID7String,
})

export const inviteSchemaCreateResponse = Type.Object({
  id: UUID7String,
  email: Type.String(),
  token: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
})

export const inviteSchemaListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      email: Type.String(),
      roleId: UUID7String,
      roleName: Type.String(),
      invitedByUserId: Nullable(UUID7String),
      expiresAt: Type.String({ format: "date-time" }),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
})

export const inviteSchemaAcceptRequest = Type.Object({
  token: Type.String({ minLength: 16, maxLength: 256 }),
})

export const inviteSchemaAcceptResponse = Type.Object({
  organizationId: UUID7String,
  organizationSlug: Type.String(),
})
