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
  /**
   * The runtime class the pod names, or null.
   *
   * Nullable because a managed cluster without `kata-deploy` has none to name, and a deployment
   * that claimed one was unschedulable — the RuntimeClass's own `scheduling.nodeSelector` is merged
   * into the pod, so it was pinned to nodes that do not exist.
   */
  runtimeClass: Nullable(Type.String()),
  /**
   * Why the most recent build failed, in the words of whatever refused it.
   *
   * Null when the build succeeded or has not finished. Present because the alternative was
   * `Build failed for deployment <uuid>` in a job's `last_error`, which no customer can read and
   * which does not say whether the Dockerfile was missing, the registry refused the push, or the
   * pod was never scheduled at all — the three failures this platform has actually had.
   */
  buildFailureReason: Nullable(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const deploymentSchemaListResponse = Type.Object({
  data: Type.Array(deploymentSchemaResponse),
})
