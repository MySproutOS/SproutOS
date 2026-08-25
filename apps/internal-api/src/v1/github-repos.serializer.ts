import { Type } from "typebox"
import { Nullable } from "../utils/common.serializer"

export const githubSchemaOrgParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
})

export const githubSchemaRepositoryListQuery = Type.Object({
  page: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1 })),
  perPage: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1 })),
})

export const githubSchemaRepositoryListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      githubRepoId: Type.String(),
      ownerLogin: Type.String(),
      name: Type.String(),
      fullName: Type.String(),
      defaultBranch: Type.String(),
      private: Type.Boolean(),
      fork: Type.Boolean(),
    }),
  ),
  installationAccountLogin: Type.String(),
  totalCount: Type.Number(),
})

/**
 * A repository name a person is part-way through typing.
 *
 * Deliberately not `pattern`-checked to GitHub's rules here. The point of this endpoint is to tell
 * somebody *why* a name will not work while they can still fix it, and a 400 from the validator
 * says only that the request was malformed. So anything short enough arrives, and the handler
 * explains what is wrong with it.
 */
export const githubSchemaNameCheckQuery = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
})

export const githubSchemaNameCheckResponse = Type.Object({
  name: Type.String(),
  /** Where it would be created. Null when no GitHub account is connected yet. */
  ownerLogin: Nullable(Type.String()),
  available: Type.Boolean(),
  /**
   * Why not, in words a person can act on. Null when it is available.
   *
   * Separate from `available` rather than encoded into it, because "already taken" and "we cannot
   * check" are different answers and a boolean flattens the second into the first.
   */
  reason: Nullable(Type.String()),
})
