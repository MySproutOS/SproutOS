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
  /** The host this deployment serves on. Stored, not derived — see the Lambda migration. */
  hostname: Nullable(Type.String()),
  /** `static` rolls back by moving the edge pointer; server presets move a Lambda alias. */
  preset: Type.String(),
  runtime: Nullable(Type.String()),
  handler: Nullable(Type.String()),
  /** The Lambda version this release published. The rollback target. */
  lambdaVersion: Nullable(Type.String()),
  /** `skipped` when the project has no migrator, which is not the same as nobody having run one. */
  migrationStatus: Nullable(Type.String()),
  /** What the migrator printed. The only useful thing to show when a deploy stops here. */
  migrationOutput: Nullable(Type.String()),
  /*
    Who released this — null for a deploy that came through CI.

    The GitHub Action authenticates as the *repository* over OIDC; there is no user in the exchange.
    Null means "CI did it" and the UI shows the repository, rather than attributing it to whoever
    happens to be looking.
  */
  createdByUserId: Nullable(UUID7String),
  /** The commit subject, so a list reads like a history rather than a column of shas. */
  gitMessage: Nullable(Type.String()),
  // The image and the revision are the platform's own identifiers rather than the customer's, but
  // they are the first thing anyone asks for when a deploy misbehaves.
  imageUri: Nullable(Type.String()),
  /*
    Not `knativeRevision`, which used to be here.

    ADR 0026 moved customer compute to Lambda, so nothing has written this since — every deployment
    returns `null`, and it is `null` in the generated client and in the OpenAPI document a customer
    reads. A field that can only ever be null is not a nullable field; it is a field that should not
    be there.

    The **column** stays. `2026_09_19_00_00_00_deployment_lambda.ts` explains why and the reasoning
    holds: `usage_event` references those rows, and a deployment history nobody can read is a
    billing dispute nobody can answer. Dropping it from the response is not dropping the record.
  */
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
  /**
   * Why the deploy failed after the image was built — Knative's own message.
   *
   * Distinct from `buildFailureReason` on purpose. That one means the image would not build; this
   * one means it built and would not run, which is the more common failure and the one most likely
   * to be the customer's own application rather than the platform.
   */
  failureReason: Nullable(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const deploymentSchemaListResponse = Type.Object({
  data: Type.Array(deploymentSchemaResponse),
})
