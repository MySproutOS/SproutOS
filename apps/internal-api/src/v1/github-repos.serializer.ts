import { Type } from "typebox"

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
