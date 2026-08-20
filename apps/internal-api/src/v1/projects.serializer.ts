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
    repositoryId: UUID7String,
  }),
])

export const projectSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  kind: Type.Optional(ProjectKind),
  rootDir: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  productionBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  agentCredentialId: Type.Optional(Nullable(UUID7String)),
  autoUpdateEnabled: Type.Optional(Type.Boolean()),
  autoUpdateMode: Type.Optional(AutoUpdateMode),
  idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
  source: ProjectSource,
})

export const projectSchemaUpdateRequest = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  rootDir: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  productionBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  agentCredentialId: Type.Optional(Nullable(UUID7String)),
  autoUpdateEnabled: Type.Optional(Type.Boolean()),
  autoUpdateMode: Type.Optional(AutoUpdateMode),
})

const projectEntry = Type.Object({
  id: UUID7String,
  name: Type.String(),
  slug: Type.String(),
  kind: Type.String(),
  state: Type.String(),
  stateReason: Nullable(Type.String()),
  rootDir: Type.String(),
  productionBranch: Type.String(),
  autoUpdateEnabled: Type.Boolean(),
  autoUpdateMode: Type.String(),
  repositoryId: UUID7String,
  storeListingId: Nullable(UUID7String),
  agentCredentialId: Nullable(UUID7String),
  createdAt: Type.String({ format: "date-time" }),
  repositoryOwnerLogin: Type.String(),
  repositoryName: Type.String(),
  repositoryProvenance: Type.String(),
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
