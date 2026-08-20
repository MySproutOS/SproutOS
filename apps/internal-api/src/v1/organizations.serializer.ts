import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const organizationSlugParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
})

export const organizationSchemaListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

const organizationEntry = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  name: Type.String(),
  kind: Type.String(),
  ownerUserId: UUID7String,
  createdAt: Type.String({ format: "date-time" }),
})

export const organizationSchemaListResponse = Type.Object({
  data: Type.Array(organizationEntry),
  nextCursor: Nullable(Type.String()),
})

export const organizationSchemaResponse = organizationEntry

export const organizationSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  slug: Type.Optional(Type.String({ minLength: 2, maxLength: 48 })),
})

export const organizationSchemaCreateResponse = Type.Object({
  id: UUID7String,
  slug: Type.String(),
})

export const organizationSchemaUpdateRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  slug: Type.Optional(Type.String({ minLength: 2, maxLength: 48 })),
})

export const organizationSchemaTransferRequest = Type.Object({
  newOwnerUserId: UUID7String,
})
