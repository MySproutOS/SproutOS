import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const userSchemaPreferencesResponse = Type.Object({
  lastOrganizationId: Nullable(UUID7String),
  lastOrganizationSlug: Nullable(Type.String()),
  sidebarCollapsed: Type.Boolean(),
  navPinnedProjectIds: Type.Array(UUID7String),
  timezone: Type.String(),
  productEmails: Type.Boolean(),
})

/**
 * What the profile screen may change.
 *
 * Every field optional, and a request that sets none is a no-op rather than an error — a PATCH is
 * defined by what it names, and requiring at least one field would make "save" fail on a form
 * nobody edited.
 */
export const userSchemaUpdateProfileRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  /** An IANA zone name. Rejected by the database if Postgres does not know it. */
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  productEmails: Type.Optional(Type.Boolean()),
  sidebarCollapsed: Type.Optional(Type.Boolean()),
})

export const userSchemaProfileResponse = Type.Object({
  name: Type.String(),
  email: Type.String(),
  timezone: Type.String(),
  productEmails: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
})
