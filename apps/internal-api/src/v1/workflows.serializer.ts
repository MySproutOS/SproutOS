import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

const graphSchema = Type.Object({
  nodes: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 100 }),
      type: Type.String(),
      name: Type.String({ maxLength: 200 }),
      config: Type.Record(Type.String(), Type.Unknown()),
      position: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
    }),
  ),
  edges: Type.Array(
    Type.Object({
      from: Type.String(),
      to: Type.String(),
      branch: Type.Optional(Nullable(Type.String())),
    }),
  ),
})

export const workflowsSchemaWorkflow = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  name: Type.String(),
  runtime: Type.String(),
  enabled: Type.Boolean(),
  currentVersion: Nullable(Type.Number()),
  createdAt: Type.String({ format: "date-time" }),
})

export const workflowsSchemaListResponse = Type.Object({
  data: Type.Array(workflowsSchemaWorkflow),
})

export const workflowsSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  runtime: Type.Optional(Type.Union([Type.Literal("node"), Type.Literal("python")])),
})

export const workflowsSchemaVersionRequest = Type.Object({
  graph: graphSchema,
})

export const workflowsSchemaVersionResponse = Type.Object({
  id: UUID7String,
  version: Type.Number(),
  graphSha256: Type.String(),
  /** True when the graph was unchanged and no new version was cut. */
  unchanged: Type.Boolean(),
})

export const workflowsSchemaRun = Type.Object({
  id: UUID7String,
  status: Type.String(),
  /**
   * Why a failed run failed.
   *
   * `workflow_run.error` was written by the runner and dropped by this serializer, so a run showed
   * `failed` and nothing else — the reason existed, in the row, and no API consumer could reach it.
   * A status with no explanation is the thing a customer opens a support ticket about.
   *
   * `code` is for the UI to branch on, `message` for a person to read.
   */
  error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
  triggerType: Type.String(),
  queueJobId: Nullable(Type.String()),
  bytesEnqueued: Type.String(),
  valkeyDwellMs: Type.String(),
  startedAt: Nullable(Type.String({ format: "date-time" })),
  finishedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
})

export const workflowsSchemaRunListResponse = Type.Object({
  data: Type.Array(workflowsSchemaRun),
})

/** TASK 35: what a person sees when they peer into a job. */
export const workflowsSchemaRunDetailResponse = Type.Object({
  run: workflowsSchemaRun,
  steps: Type.Array(
    Type.Object({
      id: UUID7String,
      nodeId: Type.String(),
      nodeType: Type.String(),
      status: Type.String(),
      startedAt: Nullable(Type.String({ format: "date-time" })),
      finishedAt: Nullable(Type.String({ format: "date-time" })),
      input: Type.Unknown(),
      output: Type.Unknown(),
    }),
  ),
  cost: Type.Object({
    usageMicroUsd: Type.String(),
    overheadMicroUsd: Type.String(),
    totalMicroUsd: Type.String(),
    byDimension: Type.Record(Type.String(), Type.String()),
  }),
})

export const workflowsSchemaIdParam = Type.Object({
  orgSlug: Type.String(),
  workflowId: UUID7String,
})

export const workflowsSchemaRunParam = Type.Object({
  orgSlug: Type.String(),
  workflowId: UUID7String,
  runId: UUID7String,
})

/**
 * A job as it sits in the tenant's queue, for TASK 35.
 *
 * `data` is `Unknown` because it is the customer's payload and we do not get to have an opinion
 * about its shape. `state` is BullMQ's vocabulary, unchanged — translating it into words of our own
 * would mean an operator reading our UI and an operator reading BullMQ's docs disagreeing about
 * what "waiting" means.
 */
export const workflowsSchemaJob = Type.Object({
  id: Type.String(),
  name: Type.String(),
  state: Type.String(),
  editable: Type.Boolean(),
  data: Type.Unknown(),
  attemptsMade: Type.Integer(),
  timestamp: Nullable(Type.Integer()),
  processedOn: Nullable(Type.Integer()),
  finishedOn: Nullable(Type.Integer()),
  failedReason: Nullable(Type.String()),
})

export const workflowsSchemaJobEditRequest = Type.Object({
  /** The replacement payload. Whatever the customer's workflow expects. */
  data: Type.Unknown(),
  /**
   * Why. Required, and required to be substantial.
   *
   * An audit row saying only who and when answers none of the questions asked after someone edits
   * what a customer's workflow will do to a customer's data.
   */
  reason: Type.String({ minLength: 8, maxLength: 2000 }),
})

export const workflowsSchemaJobEditResponse = Type.Object({
  job: workflowsSchemaJob,
  audit: Type.Object({
    id: UUID7String,
    before: Type.Unknown(),
    after: Type.Unknown(),
    createdAt: Type.String({ format: "date-time" }),
  }),
})

/**
 * A workflow as the organization-wide list shows it.
 *
 * More than `workflowsSchemaWorkflow`, which describes one project's workflow in isolation. This
 * carries the project it belongs to, its schedule, and how it has been doing — the three things a
 * list spanning every project needs to be worth looking at.
 */
export const workflowsSchemaOverview = Type.Object({
  id: UUID7String,
  name: Type.String(),
  slug: Type.String(),
  projectId: UUID7String,
  projectName: Type.String(),
  enabled: Type.Boolean(),
  /** Null when nothing schedules it — a workflow triggered by webhook or by hand. */
  cronExpression: Nullable(Type.String()),
  timezone: Nullable(Type.String()),
  lastRunAt: Nullable(Type.String({ format: "date-time" })),
  lastRunStatus: Nullable(Type.String()),
  /**
   * Failures among the recent runs the health verdict is drawn from.
   *
   * Returned alongside the verdict rather than only the verdict, so a UI can say *why* something is
   * degraded without asking again.
   */
  recentRuns: Type.Integer(),
  recentFailures: Type.Integer(),
  health: Type.String(),
  costMicroUsd: Type.String(),
})

export const workflowsSchemaOverviewResponse = Type.Object({
  data: Type.Array(workflowsSchemaOverview),
})

/** A run in the organization-wide recent-activity list. */
export const workflowsSchemaRecentRun = Type.Object({
  id: UUID7String,
  workflowId: UUID7String,
  workflowName: Type.String(),
  projectId: UUID7String,
  projectName: Type.String(),
  status: Type.String(),
  startedAt: Nullable(Type.String({ format: "date-time" })),
  finishedAt: Nullable(Type.String({ format: "date-time" })),
  /** Milliseconds, or null while it is still running. */
  durationMs: Nullable(Type.Integer()),
  costMicroUsd: Type.String(),
})

export const workflowsSchemaRecentRunsResponse = Type.Object({
  data: Type.Array(workflowsSchemaRecentRun),
})

export const workflowsSchemaWorkflowParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
  workflowId: UUID7String,
})

/**
 * One workflow and the graph the editor should open.
 *
 * `graph` is null when a workflow has been created but never saved — the editor starts from an
 * empty canvas rather than from a graph we invented on its behalf.
 */
export const workflowsSchemaDetailResponse = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  name: Type.String(),
  runtime: Type.String(),
  enabled: Type.Boolean(),
  queueName: Type.String(),
  currentVersion: Nullable(Type.Number()),
  graph: Nullable(graphSchema),
  graphSha256: Nullable(Type.String()),
  updatedAt: Type.String({ format: "date-time" }),
})
