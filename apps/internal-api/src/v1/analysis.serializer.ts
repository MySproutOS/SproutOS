import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/** A GitHub owner or repository name, as GitHub itself allows. */
const RepoSegment = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._-]+$" })

export const analysisSchemaRequest = Type.Object({
  owner: RepoSegment,
  repo: RepoSegment,
  ref: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  /** Attach the result to a project, a store listing, or neither. */
  projectId: Type.Optional(Nullable(UUID7String)),
  storeListingId: Type.Optional(Nullable(UUID7String)),
})

const manifestSchema = Type.Object({
  runtime: Type.String(),
  buildCommand: Nullable(Type.String()),
  startCommand: Nullable(Type.String()),
  port: Nullable(Type.Number()),
  services: Type.Array(Type.String()),
  envVars: Type.Array(
    Type.Object({
      name: Type.String(),
      secret: Type.Boolean(),
      providedByPlatform: Type.Boolean(),
      purpose: Type.String(),
    }),
  ),
  migrations: Nullable(Type.String()),
  modifications: Type.Array(Type.Object({ path: Type.String(), reason: Type.String() })),
  unknowns: Type.Array(Type.String()),
  summary: Type.String(),
})

export const analysisSchemaResponse = Type.Object({
  id: UUID7String,
  status: Type.String(),
  owner: Type.String(),
  repo: Type.String(),
  ref: Type.String(),
  commitSha: Nullable(Type.String()),
  confidence: Nullable(Type.Number()),
  /** Absent until the analysis finishes. */
  manifest: Nullable(manifestSchema),
  error: Nullable(Type.String()),
  costMicroUsd: Type.String({ pattern: "^-?\\d+$" }),
  createdAt: Type.String({ format: "date-time" }),
})

export const analysisSchemaListResponse = Type.Object({
  data: Type.Array(analysisSchemaResponse),
})

export const analysisSchemaIdParam = Type.Object({
  orgSlug: Type.String(),
  analysisId: UUID7String,
})
