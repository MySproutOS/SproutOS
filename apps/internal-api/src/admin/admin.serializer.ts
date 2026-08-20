import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const adminSchemaUserListQuery = Type.Object({
  /** Matched against email and GitHub login. A support request arrives with one of those two. */
  q: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(UUID7String),
})

export const adminSchemaUserRow = Type.Object({
  id: UUID7String,
  email: Type.String(),
  name: Nullable(Type.String()),
  githubLogin: Nullable(Type.String()),
  isAdmin: Type.Boolean(),
  /** Present when the account has been closed. A closed account still answers support questions. */
  deletedAt: Nullable(Type.String({ format: "date-time" })),
  organizationCount: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
})

export const adminSchemaUserListResponse = Type.Object({
  items: Type.Array(adminSchemaUserRow),
  nextCursor: Nullable(UUID7String),
})

export const adminSchemaImpersonateRequest = Type.Object({
  userId: UUID7String,
  /**
   * Why. Required, and stored on the audit row.
   *
   * A free-text field is not a control — nobody is stopped by having to type something. It is a
   * prompt: the moment where someone has to state what they are about to do is the moment they
   * notice they should not be doing it, and afterwards it is the difference between a review that
   * can be read and a list of timestamps.
   */
  reason: Type.String({ minLength: 10, maxLength: 500 }),
})

export const adminSchemaImpersonateResponse = Type.Object({
  userId: UUID7String,
  email: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
})

export const adminSchemaImpersonationStatus = Type.Object({
  impersonating: Type.Boolean(),
  /** The admin behind the current session, when there is one. */
  impersonatorUserId: Nullable(UUID7String),
  impersonatorEmail: Nullable(Type.String()),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
})
