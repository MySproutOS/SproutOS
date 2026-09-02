import { Type } from "typebox"
import { UUID7String } from "../utils/common.serializer"

const TemplateInput = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
  value: Type.Union([
    Type.String({ maxLength: 8192 }),
    Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Boolean(),
  ]),
  secret: Type.Boolean(),
})

export const templateAcceptanceSchemaParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
  listingId: UUID7String,
})

export const templateAcceptanceSchemaRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  region: Type.String({ minLength: 1, maxLength: 64 }),
  ownerLogin: Type.String({ minLength: 1, maxLength: 39 }),
  repositoryName: Type.String({ minLength: 1, maxLength: 100 }),
  githubRepoId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,19}$" })),
  reason: Type.String({ minLength: 10, maxLength: 500 }),
  templateInputs: Type.Optional(Type.Array(TemplateInput, { maxItems: 64 })),
})

export const templateAcceptanceSchemaResponse = Type.Object({
  projectId: UUID7String,
  projectJobId: UUID7String,
  repositoryId: UUID7String,
  storeListingId: UUID7String,
  catalogueEntryId: Type.String(),
  catalogueImportId: UUID7String,
  sourceSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  pluginDigest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
  projectState: Type.String(),
  jobState: Type.String(),
  repository: Type.Object({
    ownerLogin: Type.String(),
    name: Type.String(),
    private: Type.Literal(true),
  }),
})
