import { Type, type TSchema } from "typebox"
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

/**
 * One collection in an export, with the flag that says whether it is complete.
 *
 * `truncated` is part of the schema rather than a header or a convention, because a client that
 * does not know a list was cut short will present it as the whole of someone's data — and the
 * request this answers is a legal one about completeness.
 */
const Collection = <T extends TSchema>(item: T) =>
  Type.Object({ items: Type.Array(item), truncated: Type.Boolean() })

export const userSchemaExportResponse = Type.Object({
  exportedAt: Type.String({ format: "date-time" }),
  format: Type.Literal("sproutos.user-export.v1"),
  profile: Type.Object({
    id: UUID7String,
    email: Type.String(),
    name: Nullable(Type.String()),
    image: Nullable(Type.String()),
    githubLogin: Nullable(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  }),
  // Deliberately loose: preferences are a growing set of UI settings, and pinning each one here
  // would mean an export that silently omits whatever was added since.
  preferences: Nullable(Type.Record(Type.String(), Type.Unknown())),
  identities: Collection(
    Type.Object({
      provider: Type.String(),
      providerAccountId: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
  organizations: Collection(
    Type.Object({
      id: UUID7String,
      slug: Type.String(),
      name: Type.String(),
      role: Nullable(Type.String()),
      owner: Type.Boolean(),
      joinedAt: Type.String({ format: "date-time" }),
    }),
  ),
  apiKeys: Collection(
    Type.Object({
      id: UUID7String,
      name: Type.String(),
      prefix: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
      lastUsedAt: Nullable(Type.String({ format: "date-time" })),
      revokedAt: Nullable(Type.String({ format: "date-time" })),
    }),
  ),
  authorizedApplications: Collection(
    Type.Object({
      clientId: Type.String(),
      clientName: Type.String(),
      scopes: Type.Array(Type.String()),
      grantedAt: Type.String({ format: "date-time" }),
    }),
  ),
  sessions: Collection(
    Type.Object({
      createdAt: Type.String({ format: "date-time" }),
      expiresAt: Type.String({ format: "date-time" }),
    }),
  ),
  activity: Collection(
    Type.Object({
      action: Type.String(),
      resource: Nullable(Type.String()),
      organizationId: Nullable(UUID7String),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
})
