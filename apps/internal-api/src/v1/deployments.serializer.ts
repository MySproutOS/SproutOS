import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/** A 40-character git object name. */
const GitSha = Type.String({ minLength: 40, maxLength: 40, pattern: "^[0-9a-f]{40}$" })

export const deploymentSchemaRequest = Type.Object({
  gitSha: GitSha,
  gitRef: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  kind: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("preview")])),
  /** Required for a preview, and meaningless without one. */
  prNumber: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
})

export const deploymentSchemaResponse = Type.Object({
  id: UUID7String,
  projectId: UUID7String,
  kind: Type.String(),
  status: Type.String(),
  gitSha: Type.String(),
  gitRef: Nullable(Type.String()),
  prNumber: Nullable(Type.Integer()),
  url: Nullable(Type.String()),
  // The image and the revision are the platform's own identifiers rather than the customer's, but
  // they are the first thing anyone asks for when a deploy misbehaves.
  imageUri: Nullable(Type.String()),
  knativeRevision: Nullable(Type.String()),
  runtimeClass: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const deploymentSchemaListResponse = Type.Object({
  data: Type.Array(deploymentSchemaResponse),
})
