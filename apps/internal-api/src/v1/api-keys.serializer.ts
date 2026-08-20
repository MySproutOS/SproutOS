import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const apiKeysSchemaOrgParam = Type.Object({ orgSlug: Type.String() })

export const apiKeysSchemaKeyParam = Type.Object({
  orgSlug: Type.String(),
  apiKeyId: UUID7String,
})

/** A key as the settings list shows it. Never the secret — there is no route that returns it. */
export const apiKeysSchemaKey = Type.Object({
  id: UUID7String,
  name: Type.String(),
  prefix: Type.String(),
  scopes: Type.Array(Type.String()),
  createdAt: Type.String({ format: "date-time" }),
  lastUsedAt: Nullable(Type.String({ format: "date-time" })),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
  createdByUserId: UUID7String,
  createdByName: Type.String(),
})

export const apiKeysSchemaListResponse = Type.Object({
  data: Type.Array(apiKeysSchemaKey),
})

export const apiKeysSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  /**
   * RBAC actions, or `["*"]`.
   *
   * Refused if the caller does not hold them: a key cannot grant what its creator cannot do, or
   * making one would be a privilege escalation with a form in front of it.
   */
  scopes: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 100 })),
  /** Days until it stops working. Omitted means it does not expire. */
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
})

/**
 * The key, shown exactly once.
 *
 * It is stored as a one-way hash, so there is no route that could return it again — the response
 * says so rather than leaving a caller to discover it when they come back for it.
 */
export const apiKeysSchemaCreateResponse = Type.Object({
  id: UUID7String,
  key: Type.String(),
  prefix: Type.String(),
  scopes: Type.Array(Type.String()),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
})
