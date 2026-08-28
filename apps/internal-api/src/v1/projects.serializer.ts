import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

const OrgSlug = Type.String({ minLength: 2, maxLength: 48 })

export const projectSchemaOrgParam = Type.Object({ orgSlug: OrgSlug })

export const projectSchemaIdParam = Type.Object({
  orgSlug: OrgSlug,
  projectId: UUID7String,
})

export const projectSchemaJobParam = Type.Object({
  orgSlug: OrgSlug,
  projectId: UUID7String,
  jobId: UUID7String,
})

export const projectSchemaEnvVarParam = Type.Object({
  orgSlug: OrgSlug,
  projectId: UUID7String,
  envVarId: UUID7String,
})

export const projectSchemaFileParam = Type.Object({
  orgSlug: OrgSlug,
  projectId: UUID7String,
  fileId: UUID7String,
})

export const projectSchemaSuggestionParam = Type.Object({
  orgSlug: OrgSlug,
  projectId: UUID7String,
  suggestionId: UUID7String,
})

export const projectSchemaListQuery = Type.Object({
  repositoryId: Type.Optional(UUID7String),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

const ProjectKind = Type.Union([Type.Literal("site"), Type.Literal("workflow")])
const AutoUpdateMode = Type.Union([Type.Literal("suggest"), Type.Literal("auto_merge")])
const ScaleMode = Type.Union([Type.Literal("cold"), Type.Literal("warm")])
const EnvTarget = Type.Union([
  Type.Literal("production"),
  Type.Literal("preview"),
  Type.Literal("development"),
  Type.Literal("all"),
])

/**
 * The three ways a project comes into existence, behind one entry point.
 *
 * The store's fork button, the "start from scratch" button, and "add another project on a repo I
 * already have" are the same `POST`, because they differ only in where the repository comes from
 * and every step after that — slug allocation, credential resolution, the job, the audit row — is
 * identical. Two endpoints would be two places to forget the auto-update default.
 */
const ProjectSource = Type.Union([
  Type.Object({
    type: Type.Literal("store"),
    storeListingId: UUID7String,
    ownerLogin: Type.Optional(Type.String({ minLength: 1, maxLength: 39 })),
    repositoryName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    private: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("blank"),
    ownerLogin: Type.Optional(Type.String({ minLength: 1, maxLength: 39 })),
    repositoryName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    private: Type.Optional(Type.Boolean()),
    templateOwner: Type.Optional(Type.String({ minLength: 1, maxLength: 39 })),
    templateRepo: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  }),
  Type.Object({
    type: Type.Literal("repository"),
    /**
     * A repository this platform already has a row for.
     *
     * Optional now, because the dashboard's picker lists what the *installation* can reach and most
     * of those have no row here — a customer's existing repositories are not imported until they
     * are used. Sending this id was the only way to name one, so the picker sent GitHub's numeric
     * id in its place and every request failed validation before reaching a handler.
     */
    repositoryId: Type.Optional(UUID7String),
    /** GitHub's own id, which is what the picker actually knows. Imported on first use. */
    githubRepoId: Type.Optional(Type.String({ pattern: "^[0-9]+$", maxLength: 20 })),
  }),
])

export const projectSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  region: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  kind: Type.Optional(ProjectKind),
  rootDir: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  /** Relative to `rootDir`. Left out on a store fork, the listing's value is used. */
  dockerfilePath: Type.Optional(
    Type.String({ minLength: 1, maxLength: 255, pattern: "^(?!/)(?!.*\\.\\.).+$" }),
  ),
  productionBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  agentCredentialId: Type.Optional(Nullable(UUID7String)),
  autoUpdateEnabled: Type.Optional(Type.Boolean()),
  /**
   * `cold` scales to zero; `warm` keeps one instance running. ADR 0024.
   *
   * `cold` is the default because the platform's premise is that idle costs nothing. `warm` trades
   * a reserved slot for never making a request wait on a container start — and stays cheap for the
   * customer because SproutOS bills measured CPU and memory rather than reserved size, so an idle
   * instance meters close to nothing.
   */
  scaleMode: Type.Optional(ScaleMode),
  autoUpdateMode: Type.Optional(AutoUpdateMode),
  idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  /**
   * Create this as a logical grouping rather than something deployable.
   *
   * A group holds other projects and deploys nothing itself, so the UI shows it no deploy control
   * and the deploy-token exchange refuses it by name. Everything else about it is an ordinary
   * project — it is one row in one table, and `is_group` is the whole difference.
   */
  isGroup: Type.Optional(Type.Boolean()),
  /** The group this project belongs to. */
  parentProjectId: Type.Optional(Nullable(UUID7String)),
  source: ProjectSource,
})

export const projectSchemaUpdateRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  region: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 64 }))),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  rootDir: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  /** Relative to `rootDir`. Left out on a store fork, the listing's value is used. */
  dockerfilePath: Type.Optional(
    Type.String({ minLength: 1, maxLength: 255, pattern: "^(?!/)(?!.*\\.\\.).+$" }),
  ),
  productionBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  agentCredentialId: Type.Optional(Nullable(UUID7String)),
  autoUpdateEnabled: Type.Optional(Type.Boolean()),
  /**
   * `cold` scales to zero; `warm` keeps one instance running. ADR 0024.
   *
   * `cold` is the default because the platform's premise is that idle costs nothing. `warm` trades
   * a reserved slot for never making a request wait on a container start — and stays cheap for the
   * customer because SproutOS bills measured CPU and memory rather than reserved size, so an idle
   * instance meters close to nothing.
   */
  scaleMode: Type.Optional(ScaleMode),
  autoUpdateMode: Type.Optional(AutoUpdateMode),
  /** Move this project into a group, or out of one with `null`. */
  parentProjectId: Type.Optional(Nullable(UUID7String)),
  /**
   * Turn this project into a logical grouping, or back.
   *
   * Requested by the agent as often as by a person — "mark this as a grouping and generate the
   * projects it needs" is one of the things it is expected to do — which is why it lives on the
   * ordinary update route rather than behind a separate admin action.
   *
   * Refused once the project has deployed. A group holds other projects and serves nothing, so
   * converting one that is serving traffic would silently take a live site down; that is a
   * migration somebody should perform deliberately, not a flag flip.
   */
  isGroup: Type.Optional(Type.Boolean()),
  primaryChildProjectId: Type.Optional(Nullable(UUID7String)),
})

const projectEntry = Type.Object({
  id: UUID7String,
  name: Type.String(),
  description: Nullable(Type.String()),
  slug: Type.String(),
  kind: Type.String(),
  state: Type.String(),
  stateReason: Nullable(Type.String()),
  rootDir: Type.String(),
  dockerfilePath: Type.String(),
  productionBranch: Type.String(),
  autoUpdateEnabled: Type.Boolean(),
  autoUpdateMode: Type.String(),
  scaleMode: Type.String(),
  repositoryId: UUID7String,
  storeListingId: Nullable(UUID7String),
  agentCredentialId: Nullable(UUID7String),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  repositoryOwnerLogin: Type.String(),
  repositoryName: Type.String(),
  repositoryProvenance: Type.String(),
  /**
   * Micro-USD, as a string.
   *
   * A string because it is `bigint` on the way out and JSON has no integer wide enough to be
   * trusted with money — `Number` is exact only to 2^53, and a bill is not a place to find out
   * where that stops mattering.
   */
  costMicroUsd: Type.String(),
  /** Where the project's backend services live. Null until it has one. */
  region: Nullable(Type.String()),
  /** Whether the upstream this was forked from has moved ahead (TASK 17). */
  hasUpstreamUpdate: Type.Boolean(),
  /** Holds other projects; deploys nothing itself. */
  isGroup: Type.Boolean(),
  /** Static projects terminate at CloudFront and cannot use the Rust custom-domain edge yet. */
  servingMode: Nullable(Type.Union([Type.Literal("serverless"), Type.Literal("static")])),
  /** The group this belongs to, if any. */
  parentProjectId: Nullable(UUID7String),
  /** Application whose OAuth grant created this project or group, if any. */
  managedByOauthApp: Nullable(
    Type.Object({
      clientId: UUID7String,
      name: Type.String(),
    }),
  ),
  primaryChildProjectId: Nullable(UUID7String),
  primaryUrl: Nullable(Type.String()),
  primaryHostname: Nullable(Type.String()),
  /*
    Where this project is actually reachable, and on what hostname.

    Both were absent, which is why the dashboard hardcoded `url: null` and every project read "Not
    deployed yet" forever — including ones that had deployed and were serving. They come from the
    project's live deployment rather than from its most recent one: a failed deploy does not change
    where a project is reachable, and showing the newest row's URL would say it did.
  */
  url: Nullable(Type.String()),
  hostname: Nullable(Type.String()),
  /*
    Which deployment is serving right now.

    Not derivable from the deployment list: after a rollback the live release is an *older* row, so
    "the newest ready production deployment" is exactly the wrong answer at the one moment it
    matters most.
  */
  liveDeploymentId: Nullable(UUID7String),
})

export const projectSchemaEntryResponse = projectEntry

export const projectSchemaListResponse = Type.Object({
  data: Type.Array(projectEntry),
  nextCursor: Nullable(Type.String()),
})

export const projectSchemaResponse = Type.Object({
  ...projectEntry.properties,
  repository: Type.Object({
    id: UUID7String,
    githubRepoId: Nullable(Type.String()),
    ownerLogin: Type.String(),
    name: Type.String(),
    defaultBranch: Type.String(),
    private: Type.Boolean(),
    isFork: Type.Boolean(),
    provenance: Type.String(),
    upstreamFullName: Nullable(Type.String()),
    githubInstallationId: Nullable(UUID7String),
    pendingCreation: Type.Boolean(),
    liveProjectCount: Type.Number(),
  }),
  pendingUpdateSuggestions: Type.Number(),
  envVarCount: Type.Number(),
})

const projectJob = Type.Object({
  id: UUID7String,
  projectId: UUID7String,
  kind: Type.String(),
  state: Type.String(),
  progress: Type.Number(),
  attempt: Type.Number(),
  errorCode: Nullable(Type.String()),
  errorMessage: Nullable(Type.String()),
  steps: Type.Array(
    Type.Object({
      key: Type.String(),
      label: Type.String(),
      state: Type.String(),
    }),
  ),
  startedAt: Nullable(Type.String({ format: "date-time" })),
  finishedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
})

export const projectSchemaJobResponse = projectJob

export const projectSchemaJobListResponse = Type.Object({
  data: Type.Array(projectJob),
})

export const projectSchemaCreateResponse = Type.Object({
  project: projectEntry,
  job: projectJob,
})

export const projectSchemaDeleteResponse = Type.Object({
  project: Type.Object({
    id: UUID7String,
    slug: Type.String(),
    state: Type.String(),
    deletedAt: Nullable(Type.String({ format: "date-time" })),
  }),
  job: projectJob,
  jobs: Type.Array(projectJob),
  destroyed: Type.Array(Type.String()),
  scheduledForTeardown: Type.Array(Type.String()),
  retained: Type.Array(Type.String()),
  repositoryReleased: Type.Boolean(),
  remainingProjectsOnRepository: Type.Number(),
  message: Type.String(),
})

export const projectSchemaEnvVarListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      key: Type.String(),
      target: Type.String(),
      isSecret: Type.Boolean(),
      valueKmsKeyId: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
      updatedAt: Type.String({ format: "date-time" }),
    }),
  ),
})

/**
 * A variable key. Uppercase, digits, underscores, never leading with a digit.
 *
 * Deliberately stricter than the column, which is plain `text`: these end up in a process
 * environment and in a Knative container spec, and `POSIX` names are the only thing every runtime
 * agrees on.
 */
export const projectSchemaEnvVarRequest = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  value: Type.String({ maxLength: 32_768 }),
  target: Type.Optional(EnvTarget),
  isSecret: Type.Optional(Type.Boolean()),
})

export const projectSchemaEnvVarResponse = Type.Object({
  id: UUID7String,
  key: Type.String(),
  target: Type.String(),
  isSecret: Type.Boolean(),
  valueKmsKeyId: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
})

export const projectSchemaEnvVarRevealResponse = Type.Object({
  id: UUID7String,
  key: Type.String(),
  target: Type.String(),
  value: Type.String(),
})

export const projectSchemaFileListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      path: Type.String(),
      target: Type.String(),
      isSecret: Type.Boolean(),
      createdAt: Type.String({ format: "date-time" }),
      updatedAt: Type.String({ format: "date-time" }),
    }),
  ),
})

/**
 * A config file's path inside the container, and its contents.
 *
 * The path is absolute because it is the container's, not ours — `/app/config/glance.yml` means
 * whatever the image says it means, and a relative path has no anchor to resolve against. `..` is
 * refused because a `subPath` mount containing it is rejected by the kubelet, which fails the pod
 * with a message about the volume rather than about the file. The column carries the same check, so
 * a row written by hand cannot get past it either.
 *
 * A megabyte, because a Secret is capped at 1 MiB *in total* and a config file that approaches that
 * is not a config file. The limit is here rather than only at the cluster so the customer is told
 * which file is too large, instead of watching the whole deployment fail to apply.
 */
export const projectSchemaFileRequest = Type.Object({
  path: Type.String({ minLength: 2, maxLength: 4096, pattern: "^/(?!.*\\.\\.)[^\\0]*[^/]$" }),
  contents: Type.String({ maxLength: 1_000_000 }),
  target: Type.Optional(EnvTarget),
  isSecret: Type.Optional(Type.Boolean()),
})

export const projectSchemaFileResponse = Type.Object({
  id: UUID7String,
  path: Type.String(),
  target: Type.String(),
  isSecret: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
})

export const projectSchemaFileRevealResponse = Type.Object({
  id: UUID7String,
  path: Type.String(),
  target: Type.String(),
  contents: Type.String(),
})

export const projectSchemaSuggestionListQuery = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("accepted"),
      Type.Literal("dismissed"),
      Type.Literal("applied"),
    ]),
  ),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

const suggestionEntry = Type.Object({
  id: UUID7String,
  status: Type.String(),
  summary: Nullable(Type.String()),
  resolvedAt: Nullable(Type.String({ format: "date-time" })),
  resolvedByUserId: Nullable(UUID7String),
  createdAt: Type.String({ format: "date-time" }),
  upstreamSyncRunId: UUID7String,
  branch: Type.String(),
  behindBy: Type.Number(),
  aheadBy: Type.Number(),
  outcome: Type.String(),
  mergeType: Nullable(Type.String()),
  pullRequestNumber: Nullable(Type.Number()),
  pullRequestUrl: Nullable(Type.String()),
})

export const projectSchemaSuggestionListResponse = Type.Object({
  data: Type.Array(suggestionEntry),
  nextCursor: Nullable(Type.String()),
})

export const projectSchemaSuggestionResponse = suggestionEntry

export const repositorySchemaListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const repositorySchemaListResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      githubRepoId: Nullable(Type.String()),
      ownerLogin: Type.String(),
      name: Type.String(),
      defaultBranch: Type.String(),
      private: Type.Boolean(),
      isFork: Type.Boolean(),
      provenance: Type.String(),
      upstreamFullName: Nullable(Type.String()),
      githubInstallationId: Nullable(UUID7String),
      pendingCreation: Type.Boolean(),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
  nextCursor: Nullable(Type.String()),
})
