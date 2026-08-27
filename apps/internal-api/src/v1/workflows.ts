import {
  EDITABLE_STATES,
  JobNotEditableError,
  JobNotFoundError,
  readJob,
  updateJobData,
  type JobSnapshot,
  type QueueLocation,
} from "@lib/queue"
import {
  hashGraph,
  InvalidGraphError,
  rateWorkflowRun,
  validateGraph,
  type WorkflowGraph,
} from "@lib/workflows"
import { JOB_KINDS, enqueue, stepRowsFor } from "@lib/jobs"
import { crudMeteringOutbox } from "@lib/dao"
import { rateProjectsForOrganization, startOfMonth } from "@lib/billing/usage"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { sql } from "kysely"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { collectionResource, paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import {
  workflowsSchemaCreateRequest,
  workflowsSchemaDetailResponse,
  workflowsSchemaIdParam,
  workflowsSchemaJob,
  workflowsSchemaJobEditRequest,
  workflowsSchemaJobEditResponse,
  workflowsSchemaListResponse,
  workflowsSchemaOverviewResponse,
  workflowsSchemaRecentRunsResponse,
  workflowsSchemaRunDetailResponse,
  workflowsSchemaRun,
  workflowsSchemaRunListResponse,
  workflowsSchemaRunParam,
  workflowsSchemaVersionRequest,
  workflowsSchemaVersionResponse,
  workflowsSchemaWorkflow,
  workflowsSchemaWorkflowParam,
} from "./workflows.serializer"
import { workflowJobsOutboxRecord } from "./workflow-metering"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * Workflows live under a project, which is what scopes them to an organization — there is no
 * `organization_id` on `workflow`, so every query joins through `project` and that join *is* the
 * tenancy check.
 */
/*
  Annotated `Hono`, like the registry in ./index.ts.

  Each `.get()`/`.put()` returns a type carrying every route registered so far, and five routes
  with typebox validators on both params and body is enough to reach TS2589 — which reports no
  file and no line, so it is worth stopping here rather than discovering it from the next route.
*/
/**
 * How many recent runs a health verdict is drawn from.
 *
 * A workflow that failed once six months ago is healthy; one that failed twice this morning is not.
 * Ten is enough to tell a flake from a pattern and few enough that the window query stays cheap.
 */
const RECENT_RUN_WINDOW = 10

/** How many runs the organization-wide activity feed shows. */
const RECENT_ACTIVITY_LIMIT = 50

/** Run statuses that count against a workflow's health. */
const FAILED_STATUSES = new Set(["failed", "dead_lettered"])

/**
 * A workflow's health, in one word.
 *
 * Disabled beats everything: a paused workflow is not failing, it is off, and calling it "failing"
 * would have someone investigate a thing they turned off themselves.
 *
 * A workflow with no runs is "healthy" rather than "unknown". Its first run has not happened, which
 * is not a problem — and a fourth state that means "nothing yet" is a state every list has to
 * explain.
 */
function healthOf(
  enabled: boolean,
  recentRuns: number,
  failures: number,
  latestStatus: string | undefined,
): string {
  if (!enabled) return "paused"
  if (recentRuns === 0) return "healthy"
  if (latestStatus !== undefined && FAILED_STATUSES.has(latestStatus)) return "failing"
  return failures > 0 ? "degraded" : "healthy"
}

/** Steps per run, which is what `jobsEnqueued` bills on. One query for the whole page. */
async function stepCountsFor(runIds: readonly string[]): Promise<Map<string, number>> {
  if (runIds.length === 0) return new Map()
  const rows = await db
    .selectFrom("workflowRunStep")
    .select(["workflowRunId", (eb) => eb.fn.countAll<string>().as("steps")])
    .where("workflowRunId", "in", runIds)
    .groupBy("workflowRunId")
    .execute()
  return new Map(rows.map((row) => [row.workflowRunId, Number(row.steps)]))
}

const app: Hono = new Hono()
app.use(authMiddleware)
app
  /**
   * One workflow, with the graph the editor opens.
   *
   * Separate from the list because a graph is large and a list of them would be a page nobody can
   * load. `workflow:read` rather than `workflow:job:read`: a graph is the *shape* of the work, not
   * the data it handled.
   */
  .get(
    "/:orgSlug/projects/:projectId/workflows/:workflowId",
    describeRoute({
      description: "One workflow and its current graph",
      responses: {
        200: {
          description: "Workflow",
          content: { "application/json": { schema: resolver(workflowsSchemaDetailResponse) } },
        },
        403: { description: "Caller lacks workflow:read", ...errorResponse },
        404: { description: "No such workflow", ...errorResponse },
      },
    }),
    requirePermission("workflow:read", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaWorkflowParam),
    async (c) => {
      const { workflowId } = c.req.valid("param")

      const row = await db
        .selectFrom("workflow")
        .innerJoin("project", "project.id", "workflow.projectId")
        .leftJoin("workflowVersion", "workflowVersion.id", "workflow.currentVersionId")
        .select([
          "workflow.id as id",
          "workflow.slug as slug",
          "workflow.name as name",
          "workflow.runtime as runtime",
          "workflow.enabled as enabled",
          "workflow.queueName as queueName",
          "workflow.updatedAt as updatedAt",
          "workflowVersion.version as version",
          "workflowVersion.graph as graph",
          "workflowVersion.graphSha256 as graphSha256",
        ])
        .where("workflow.id", "=", workflowId)
        .where("project.organizationId", "=", c.var.organization.id)
        .where("workflow.deletedAt", "is", null)
        .where("project.deletedAt", "is", null)
        .executeTakeFirst()

      if (row === undefined) return throwNotFound(c, "Workflow not found")

      return c.json({
        id: row.id,
        slug: row.slug,
        name: row.name,
        runtime: row.runtime,
        enabled: row.enabled,
        queueName: row.queueName,
        currentVersion: row.version ?? null,
        // Null, not an empty graph: a workflow that has never been saved has no graph, and handing
        // the editor `{nodes: [], edges: []}` would make "never saved" and "saved empty"
        // indistinguishable — and the second is a graph `validateGraph` refuses.
        graph: (row.graph as unknown) ?? null,
        graphSha256: row.graphSha256 ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })
    },
  )
  /**
   * Every workflow in the organization, across its projects.
   *
   * The per-project list exists and is the right shape for a project page. This one is what the
   * dashboard's Workflows screen needs, and it is a separate endpoint rather than the client
   * fanning out over projects: a caller with twenty projects would otherwise make twenty requests,
   * and would have to know which projects exist before it could ask.
   */
  .get(
    "/:orgSlug/workflows",
    describeRoute({
      description: "Every workflow in the organization, with its schedule and recent health",
      responses: {
        200: {
          description: "Workflows",
          content: { "application/json": { schema: resolver(workflowsSchemaOverviewResponse) } },
        },
        403: { description: "Caller lacks workflow:read", ...errorResponse },
      },
    }),
    requirePermission("workflow:read", collectionResource("workflow", "workflow")),
    async (c) => {
      const organizationId = c.var.organization.id

      const workflows = await db
        .selectFrom("workflow")
        .innerJoin("project", "project.id", "workflow.projectId")
        .leftJoin("workflowSchedule", "workflowSchedule.workflowId", "workflow.id")
        .select([
          "workflow.id as id",
          "workflow.name as name",
          "workflow.slug as slug",
          "workflow.enabled as enabled",
          "project.id as projectId",
          "project.name as projectName",
          "workflowSchedule.cronExpression as cronExpression",
          "workflowSchedule.timezone as timezone",
          "workflowSchedule.enabled as scheduleEnabled",
        ])
        .where("project.organizationId", "=", organizationId)
        .where("workflow.deletedAt", "is", null)
        .where("project.deletedAt", "is", null)
        .orderBy("workflow.name", "asc")
        .execute()

      if (workflows.length === 0) return c.json({ data: [] })

      const workflowIds = workflows.map((row) => row.id)

      /*
        Health is drawn from the last few runs, not from all of history.

        A workflow that failed once six months ago is healthy; one that failed twice this morning is
        not. `RECENT_RUN_WINDOW` runs is what "recently" means here, and taking it per workflow needs
        a window function — a plain `limit` would take the newest runs across *every* workflow and
        tell a busy one's story about a quiet one.
      */
      const runs = await db
        .selectFrom(
          db
            .selectFrom("workflowRun")
            .select([
              "id",
              "workflowId",
              "status",
              "startedAt",
              "finishedAt",
              "createdAt",
              sql<number>`row_number() over (partition by workflow_id order by created_at desc)`.as(
                "recency",
              ),
            ])
            .where("workflowId", "in", workflowIds)
            .as("ranked"),
        )
        .selectAll()
        .where("recency", "<=", RECENT_RUN_WINDOW)
        .execute()

      const byWorkflow = new Map<string, typeof runs>()
      for (const run of runs) {
        const existing = byWorkflow.get(run.workflowId) ?? []
        existing.push(run)
        byWorkflow.set(run.workflowId, existing)
      }

      const rated = await rateProjectsForOrganization(db, organizationId, startOfMonth())

      return c.json({
        data: workflows.map((workflow) => {
          const recent = (byWorkflow.get(workflow.id) ?? []).sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          )
          const latest = recent[0]
          const failures = recent.filter((run) => FAILED_STATUSES.has(run.status)).length

          return {
            id: workflow.id,
            name: workflow.name,
            slug: workflow.slug,
            projectId: workflow.projectId,
            projectName: workflow.projectName,
            enabled: workflow.enabled,
            /*
              A schedule row that exists but is disabled is *not* a schedule. Reporting the cron
              expression anyway would have the UI show "every 15 minutes" for something that has not
              run in a month.
            */
            cronExpression:
              workflow.scheduleEnabled === true ? (workflow.cronExpression ?? null) : null,
            timezone: workflow.scheduleEnabled === true ? (workflow.timezone ?? null) : null,
            lastRunAt:
              (latest?.finishedAt ?? latest?.startedAt ?? latest?.createdAt)?.toISOString() ?? null,
            lastRunStatus: latest?.status ?? null,
            recentRuns: recent.length,
            recentFailures: failures,
            health: healthOf(workflow.enabled, recent.length, failures, latest?.status),
            /*
              Cost is the *project's* metered cost, not the workflow's.

              `usage_rollup` has a `project_id` and no `workflow_id`, so this is the honest grain
              available; attributing a project's spend to one of its workflows would be a number
              that looks precise and is not.

              **This does not agree with the per-run cost below**, and will not until the metering
              pipeline writes rollups for workflow runs. A run's cost is rated from its own columns
              — bytes enqueued, dwell, elapsed — which is an estimate of what that run consumed. A
              project's cost is what has actually been metered against it, which today is nothing.
              The two are different questions with different sources, and making them agree by
              summing run estimates into the project total would be inventing meter readings.
            */
            costMicroUsd: (rated.get(workflow.projectId)?.total ?? 0n).toString(),
          }
        }),
      })
    },
  )
  /**
   * Recent runs across the organization, newest first.
   *
   * The activity feed the Workflows screen shows underneath the list. Same reasoning as above: one
   * request rather than one per workflow.
   */
  .get(
    "/:orgSlug/workflow-runs",
    describeRoute({
      description: "Recent workflow runs across the organization",
      responses: {
        200: {
          description: "Runs",
          content: { "application/json": { schema: resolver(workflowsSchemaRecentRunsResponse) } },
        },
        403: { description: "Caller lacks workflow:job:read", ...errorResponse },
      },
    }),
    // `workflow:job:read`, not `workflow:read`: a run carries what the workflow was processing, and
    // being allowed to see that a workflow exists is a different thing from seeing what it handled.
    requirePermission("workflow:job:read", collectionResource("workflow", "workflow")),
    async (c) => {
      const runs = await db
        .selectFrom("workflowRun")
        .innerJoin("workflow", "workflow.id", "workflowRun.workflowId")
        .innerJoin("project", "project.id", "workflow.projectId")
        .select([
          "workflowRun.id as id",
          "workflowRun.status as status",
          "workflowRun.startedAt as startedAt",
          "workflowRun.finishedAt as finishedAt",
          "workflowRun.createdAt as createdAt",
          "workflowRun.bytesEnqueued as bytesEnqueued",
          "workflowRun.valkeyDwellMs as valkeyDwellMs",
          "workflow.id as workflowId",
          "workflow.name as workflowName",
          "project.id as projectId",
          "project.name as projectName",
        ])
        .where("project.organizationId", "=", c.var.organization.id)
        .where("workflow.deletedAt", "is", null)
        .where("project.deletedAt", "is", null)
        .orderBy("workflowRun.createdAt", "desc")
        .limit(RECENT_ACTIVITY_LIMIT)
        .execute()

      const stepCounts = await stepCountsFor(runs.map((run) => run.id))

      return c.json({
        data: await Promise.all(
          runs.map(async (run) => {
            const elapsed = elapsedSeconds(run.startedAt, run.finishedAt)
            const cost = await rateWorkflowRun(db, {
              jobsEnqueued: stepCounts.get(run.id) ?? 0,
              bytesEnqueued: run.bytesEnqueued === null ? null : BigInt(run.bytesEnqueued),
              dwellMs: run.valkeyDwellMs === null ? null : BigInt(run.valkeyDwellMs),
              vcpuSeconds: elapsed,
              gibSeconds: elapsed * 0.5,
            })

            return {
              id: run.id,
              workflowId: run.workflowId,
              workflowName: run.workflowName,
              projectId: run.projectId,
              projectName: run.projectName,
              status: run.status,
              startedAt: run.startedAt?.toISOString() ?? null,
              finishedAt: run.finishedAt?.toISOString() ?? null,
              // Null while it is still running: a duration for something unfinished would be
              // "so far", and a table column cannot say that.
              durationMs:
                run.startedAt !== null && run.finishedAt !== null
                  ? run.finishedAt.getTime() - run.startedAt.getTime()
                  : null,
              costMicroUsd: cost.complete ? cost.total.toString() : null,
            }
          }),
        ),
      })
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/workflows",
    describeRoute({
      description: "Lists a project's workflows",
      responses: {
        200: {
          description: "Workflows",
          content: { "application/json": { schema: resolver(workflowsSchemaListResponse) } },
        },
        403: { description: "Caller lacks workflow:read", ...errorResponse },
      },
    }),
    requirePermission("workflow:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const rows = await db
        .selectFrom("workflow")
        .innerJoin("project", "project.id", "workflow.projectId")
        .leftJoin("workflowVersion", "workflowVersion.id", "workflow.currentVersionId")
        .select([
          "workflow.id as id",
          "workflow.slug as slug",
          "workflow.name as name",
          "workflow.runtime as runtime",
          "workflow.enabled as enabled",
          "workflow.createdAt as createdAt",
          "workflowVersion.version as currentVersion",
        ])
        .where("workflow.projectId", "=", c.req.param("projectId"))
        .where("project.organizationId", "=", c.var.organization.id)
        .where("workflow.deletedAt", "is", null)
        .orderBy("workflow.createdAt", "desc")
        .execute()

      return c.json({
        data: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/workflows",
    describeRoute({
      description: "Creates a workflow",
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: resolver(workflowsSchemaWorkflow) } },
        },
        400: { description: "Name already used in this project", ...errorResponse },
        403: { description: "Caller lacks workflow:run", ...errorResponse },
      },
    }),
    requirePermission("workflow:run", paramResource("project", "project", "projectId")),
    validator("json", workflowsSchemaCreateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const projectId = c.req.param("projectId")

      const project = await db
        .selectFrom("project")
        .select("id")
        .where("id", "=", projectId)
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .executeTakeFirst()
      if (project === undefined) return throwNotFound(c, "Project not found")

      const slug = slugify(body.name)
      if (slug === "") return throwBadRequest(c, "That name has no usable characters in it")

      try {
        const created = await db
          .insertInto("workflow")
          .values({
            id: v7(),
            projectId,
            slug,
            name: body.name,
            runtime: body.runtime ?? "node",
            // The queue a tenant's BullMQ or Celery client points at. Derived from ids rather
            // than the name, so renaming a workflow does not orphan its in-flight jobs.
            queueName: `sprout.${projectId}.${slug}`,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        return c.json(
          {
            id: created.id,
            slug: created.slug,
            name: created.name,
            runtime: created.runtime,
            enabled: created.enabled,
            currentVersion: null,
            createdAt: created.createdAt.toISOString(),
          },
          201,
        )
      } catch (error) {
        if (String(error).includes("workflow_project_slug_live_key")) {
          return throwBadRequest(c, "A workflow with that name already exists in this project")
        }
        throw error
      }
    },
  )
  .put(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/graph",
    describeRoute({
      description: "Saves a graph as a new version, if it changed",
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: resolver(workflowsSchemaVersionResponse) } },
        },
        400: { description: "The graph cannot run", ...errorResponse },
        403: { description: "Caller lacks workflow:run", ...errorResponse },
        404: { description: "No such workflow", ...errorResponse },
      },
    }),
    requirePermission("workflow:run", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaIdParam),
    validator("json", workflowsSchemaVersionRequest),
    async (c) => {
      const { workflowId } = c.req.valid("param")
      const graph = c.req.valid("json").graph as WorkflowGraph

      const workflow = await ownedWorkflow(c.var.organization.id, workflowId)
      if (workflow === undefined) return throwNotFound(c, "Workflow not found")

      try {
        // Validated before anything is written, so a graph that cannot run is rejected in the
        // editor with the offending node named — rather than at 3am, half-executed.
        validateGraph(graph)
      } catch (error) {
        if (error instanceof InvalidGraphError) {
          return throwBadRequest(
            c,
            error.nodeId === null ? error.problem : `${error.problem} (node ${error.nodeId})`,
          )
        }
        throw error
      }

      const graphSha256 = await hashGraph(graph)

      /*
        No new version when nothing changed.

        The hash excludes canvas coordinates, so dragging a node around and saving does not cut a
        version. A version per nudge makes the history useless for the question it exists to
        answer: what actually changed about what this runs.
      */
      const current = await db
        .selectFrom("workflowVersion")
        .select(["id", "version", "graphSha256"])
        .where("id", "=", workflow.currentVersionId ?? "00000000-0000-0000-0000-000000000000")
        .executeTakeFirst()

      if (current !== undefined && current.graphSha256 === graphSha256) {
        return c.json({
          id: current.id,
          version: current.version,
          graphSha256,
          unchanged: true,
        })
      }

      const saved = await db.transaction().execute(async (tx) => {
        const version = await tx
          .insertInto("workflowVersion")
          .values(() => ({
            id: v7(),
            workflowId,
            createdByUserId: c.var.user.id,
            graph: JSON.stringify(graph),
            graphSha256,
            /*
              max + 1, derived inside the INSERT.

              Two concurrent saves therefore collide on
              workflow_version_workflow_version_key rather than both computing the same number
              from a read that happened before either wrote.

              The `+ 1` is not decoration: storing the bare max makes the first version 0, which
              then collides with itself on the second save. Both symptoms — a version numbered 0
              and a 500 on the next edit — came from leaving it out.
            */
            version: sql<number>`(
              select coalesce(max(prior.version), 0) + 1
                from workflow_version as prior
               where prior.workflow_id = ${workflowId}
            )`,
          }))
          .returning(["id", "version"])
          .executeTakeFirstOrThrow()

        await tx
          .updateTable("workflow")
          .set({ currentVersionId: version.id, updatedAt: new Date() })
          .where("id", "=", workflowId)
          .execute()

        return version
      })

      // The stored number, not a recomputed one — the two disagreeing is exactly the bug above.
      return c.json({ id: saved.id, version: saved.version, graphSha256, unchanged: false })
    },
  )
  /**
   * Start a run.
   *
   * **There was no way to.** The runs endpoints listed runs, read one, and read and edited the
   * BullMQ job behind it — and `workflow_run` was written by nothing in either language, so all
   * four read a table that was always empty. The design has runs originating from a tenant's own
   * BullMQ client through `valkey-proxy`, which is right for production traffic and leaves a
   * customer no way to try the workflow they just drew.
   *
   * `trigger_type: "manual"` distinguishes these from queue-originated runs, so billing and the
   * run list can tell "someone pressed run" from "a customer's job arrived".
   *
   * The steps are written here rather than by the worker, in the same transaction as the run: an
   * empty step list between "queued" and the worker picking it up reads as a stuck run, which is
   * the mistake `project_job` already made once.
   */
  .post(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/runs",
    describeRoute({
      description: "Starts a run of the workflow's current version",
      responses: {
        201: {
          description: "The queued run",
          content: { "application/json": { schema: resolver(workflowsSchemaRun) } },
        },
        403: { description: "Caller lacks workflow:run", ...errorResponse },
        404: { description: "No such workflow", ...errorResponse },
        409: { description: "The workflow has no saved version, or is disabled", ...errorResponse },
      },
    }),
    requirePermission("workflow:run", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaIdParam),
    async (c) => {
      const { workflowId } = c.req.valid("param")
      const workflow = await ownedWorkflow(c.var.organization.id, workflowId)
      if (workflow === undefined) return throwNotFound(c, "Workflow not found")

      if (!workflow.enabled) {
        return throwConflict(c, "This workflow is disabled")
      }
      if (workflow.currentVersionId === null) {
        // A workflow with no saved version has no graph, so there is nothing to order into steps.
        // 409 rather than 400: the request is well-formed, the resource is not ready.
        return throwConflict(c, "Save a version of this workflow before running it")
      }

      const version = await db
        .selectFrom("workflowVersion")
        .select(["id", "graph"])
        .where("id", "=", workflow.currentVersionId)
        .executeTakeFirst()
      if (version === undefined) return throwNotFound(c, "Workflow version not found")

      const runId = v7()
      const steps = stepRowsFor(runId, version.graph as WorkflowGraph)
      const occurredAt = new Date()

      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto("workflowRun")
          .values({
            id: runId,
            workflowId,
            workflowVersionId: version.id,
            triggerType: "manual",
            status: "queued",
            createdAt: occurredAt,
          })
          .execute()

        if (steps.length > 0) await tx.insertInto("workflowRunStep").values(steps).execute()

        const usage = workflowJobsOutboxRecord({
          runId,
          workflowId,
          workflowVersionId: version.id,
          organizationId: c.var.organization.id,
          projectId: workflow.projectId,
          jobs: steps.length,
          occurredAt,
        })
        if (usage !== undefined) {
          await crudMeteringOutbox(tx).create({ id: v7(), ...usage })
        }
      })

      // Outside the transaction on purpose: the worker polls `background_job`, and a job visible
      // before its run row committed would be claimed and find nothing.
      await enqueue(db, {
        kind: JOB_KINDS.workflowRun,
        idempotencyKey: `${JOB_KINDS.workflowRun}:${runId}`,
        payload: { workflowRunId: runId },
        maxAttempts: 3,
      })

      const run = await db
        .selectFrom("workflowRun")
        .selectAll()
        .where("id", "=", runId)
        .executeTakeFirstOrThrow()

      return c.json(presentRun(run), 201)
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/runs",
    describeRoute({
      description: "Lists a workflow's runs",
      responses: {
        200: {
          description: "Runs",
          content: { "application/json": { schema: resolver(workflowsSchemaRunListResponse) } },
        },
        403: { description: "Caller lacks workflow:read", ...errorResponse },
      },
    }),
    requirePermission("workflow:read", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaIdParam),
    async (c) => {
      const { workflowId } = c.req.valid("param")
      const workflow = await ownedWorkflow(c.var.organization.id, workflowId)
      if (workflow === undefined) return throwNotFound(c, "Workflow not found")

      const runs = await db
        .selectFrom("workflowRun")
        .selectAll()
        .where("workflowId", "=", workflowId)
        .orderBy("createdAt", "desc")
        .limit(50)
        .execute()

      return c.json({ data: runs.map(presentRun) })
    },
  )
  /**
   * TASK 35: peering into a job.
   *
   * `workflow:job:read` rather than `workflow:read`, because a run's step inputs and outputs carry
   * whatever the workflow was processing — a customer record, an invoice, an API response. Being
   * allowed to see that a workflow exists is a different thing from being allowed to read what it
   * handled.
   */
  .get(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/runs/:runId",
    describeRoute({
      description: "One run, its steps, and what it cost",
      responses: {
        200: {
          description: "Run detail",
          content: {
            "application/json": { schema: resolver(workflowsSchemaRunDetailResponse) },
          },
        },
        403: { description: "Caller lacks workflow:job:read", ...errorResponse },
        404: { description: "No such run", ...errorResponse },
      },
    }),
    requirePermission("workflow:job:read", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaRunParam),
    async (c) => {
      const { workflowId, runId } = c.req.valid("param")
      const workflow = await ownedWorkflow(c.var.organization.id, workflowId)
      if (workflow === undefined) return throwNotFound(c, "Workflow not found")

      const run = await db
        .selectFrom("workflowRun")
        .selectAll()
        .where("id", "=", runId)
        .where("workflowId", "=", workflowId)
        .executeTakeFirst()
      if (run === undefined) return throwNotFound(c, "Run not found")

      const steps = await db
        .selectFrom("workflowRunStep")
        .selectAll()
        .where("workflowRunId", "=", runId)
        .orderBy("createdAt", "asc")
        .execute()

      // TASK 25's four dimensions, rated at read time against the price book in force. The queue
      // cost is bytes × seconds, which is why the two columns are stored rather than a product.
      const rated = await rateWorkflowRun(db, {
        jobsEnqueued: steps.length,
        bytesEnqueued: run.bytesEnqueued === null ? null : BigInt(run.bytesEnqueued),
        dwellMs: run.valkeyDwellMs === null ? null : BigInt(run.valkeyDwellMs),
        vcpuSeconds: elapsedSeconds(run.startedAt, run.finishedAt),
        gibSeconds: elapsedSeconds(run.startedAt, run.finishedAt) * 0.5,
      })

      return c.json({
        run: presentRun(run),
        steps: steps.map((step) => ({
          id: step.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          status: step.status,
          startedAt: step.startedAt?.toISOString() ?? null,
          finishedAt: step.finishedAt?.toISOString() ?? null,
          input: step.input,
          output: step.output,
        })),
        cost: {
          usageMicroUsd: rated.usage.toString(),
          overheadMicroUsd: rated.overhead.toString(),
          totalMicroUsd: rated.total.toString(),
          byDimension: Object.fromEntries(
            Object.entries(rated.byDimension).map(([key, value]) => [key, value.toString()]),
          ),
          complete: rated.complete,
          missingDimensions: rated.missingDimensions,
        },
      })
    },
  )
  /**
   * TASK 35: the job itself, as it sits in the queue.
   *
   * `workflow_run` records that a run happened and what it cost; it has no `input` column, because
   * the payload lives in Valkey where the tenant's BullMQ client put it. So this reaches into the
   * tenant's namespace rather than reading a row.
   */
  .get(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/runs/:runId/job",
    describeRoute({
      description: "The queued job behind a run",
      responses: {
        200: {
          description: "Job",
          content: { "application/json": { schema: resolver(workflowsSchemaJob) } },
        },
        403: { description: "Caller lacks workflow:job:read", ...errorResponse },
        404: { description: "No such run, or no job behind it", ...errorResponse },
        409: { description: "The project has no queue service", ...errorResponse },
      },
    }),
    requirePermission("workflow:job:read", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaRunParam),
    async (c) => {
      const { workflowId, runId } = c.req.valid("param")
      const located = await locateJob(c.var.organization.id, workflowId, runId)
      if (located === undefined) return throwNotFound(c, "Run not found")
      if (located.problem !== undefined) return throwConflict(c, located.problem)

      try {
        return c.json(presentJob(await readJob(located.location, located.queueJobId)))
      } catch (cause) {
        if (cause instanceof JobNotFoundError) {
          /*
            The run exists but its job does not.

            This is ordinary rather than exceptional: BullMQ removes completed jobs once
            `removeOnComplete` trims them, so a run from last month has a row here and nothing in
            Valkey. Saying so beats a 500.
          */
          return throwNotFound(c, "The job is no longer in the queue")
        }
        throw cause
      }
    },
  )
  /**
   * TASK 35's other half: modifying job data.
   *
   * `workflow:job:modify`, and a `reason` that is not optional. Editing a queued job changes what a
   * customer's workflow is about to do to a customer's data — the audit row is written in the same
   * request and records the payload this edit actually replaced.
   *
   * The audit is written *after* the queue accepts the edit, deliberately. The other order would
   * record edits that never landed, which is worse than recording none: a trail that contains
   * things that did not happen cannot be used to work out what did.
   */
  .patch(
    "/:orgSlug/projects/:projectId/workflows/:workflowId/runs/:runId/job",
    describeRoute({
      description: "Replace a queued job's data",
      responses: {
        200: {
          description: "The job as it now stands, and the audit row",
          content: { "application/json": { schema: resolver(workflowsSchemaJobEditResponse) } },
        },
        403: { description: "Caller lacks workflow:job:modify", ...errorResponse },
        404: { description: "No such run, or no job behind it", ...errorResponse },
        409: {
          description: "The job has started or finished, or there is no queue service",
          ...errorResponse,
        },
      },
    }),
    requirePermission("workflow:job:modify", paramResource("project", "project", "projectId")),
    validator("param", workflowsSchemaRunParam),
    validator("json", workflowsSchemaJobEditRequest),
    async (c) => {
      const { workflowId, runId } = c.req.valid("param")
      const { data, reason } = c.req.valid("json")

      const located = await locateJob(c.var.organization.id, workflowId, runId)
      if (located === undefined) return throwNotFound(c, "Run not found")
      if (located.problem !== undefined) return throwConflict(c, located.problem)

      let edit
      try {
        edit = await updateJobData(located.location, located.queueJobId, data)
      } catch (cause) {
        if (cause instanceof JobNotFoundError) {
          return throwNotFound(c, "The job is no longer in the queue")
        }
        // `active` and the finished states each have their own explanation; the library writes a
        // better one than a generic 409 message would.
        if (cause instanceof JobNotEditableError) return throwConflict(c, cause.message)
        throw cause
      }

      const auditId = v7()
      await db
        .insertInto("workflowJobEditAudit")
        .values({
          id: auditId,
          workflowRunId: runId,
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          queueJobId: located.queueJobId,
          jobStateAtEdit: edit.state,
          before: JSON.stringify(edit.before),
          after: JSON.stringify(edit.after),
          reason,
        })
        .execute()

      return c.json({
        job: presentJob(await readJob(located.location, located.queueJobId)),
        audit: {
          id: auditId,
          before: edit.before,
          after: edit.after,
          createdAt: new Date().toISOString(),
        },
      })
    },
  )

/**
 * Where the shared Valkey actually is.
 *
 * The **admin** URL, not the proxy: the control plane connects directly and applies the tenant's
 * namespace itself. It could not go through the proxy even if it wanted to — the tenant's secret is
 * stored as a one-way hash, so there is nothing to authenticate with, which is the property that
 * makes a stolen credential table worthless.
 */
function valkeyAdminUrl(): string | undefined {
  const url = process.env.SERVICE_VALKEY_ADMIN_URL
  return url === undefined || url === "" ? undefined : url
}

function presentJob(job: JobSnapshot) {
  return {
    ...job,
    // Computed here rather than left to the client: whether an edit will be accepted is this
    // service's rule, and a UI that decides for itself will eventually disagree with it.
    editable: (EDITABLE_STATES as readonly string[]).includes(job.state),
  }
}

/**
 * Resolves a run to the queue its job lives in.
 *
 * Returns `undefined` when the run is not this organization's — the same answer as "no such run",
 * because the two must not be distinguishable. A `problem` is a run that exists but whose job
 * cannot be reached, which is a different thing from a missing run and gets a 409.
 */
async function locateJob(
  organizationId: string,
  workflowId: string,
  runId: string,
): Promise<
  | { queueJobId: string; location: QueueLocation; problem?: undefined }
  | { problem: string; queueJobId?: undefined; location?: undefined }
  | undefined
> {
  const row = await db
    .selectFrom("workflowRun")
    .innerJoin("workflow", "workflow.id", "workflowRun.workflowId")
    .innerJoin("project", "project.id", "workflow.projectId")
    .select([
      "workflowRun.queueJobId as queueJobId",
      "workflow.queueName as queueName",
      "project.id as projectId",
    ])
    .where("workflowRun.id", "=", runId)
    .where("workflowRun.workflowId", "=", workflowId)
    .where("project.organizationId", "=", organizationId)
    .where("workflow.deletedAt", "is", null)
    .where("project.deletedAt", "is", null)
    .executeTakeFirst()

  if (row === undefined) return undefined
  if (row.queueJobId === null) {
    return { problem: "This run was never enqueued, so it has no job to inspect" }
  }

  const service = await db
    .selectFrom("backendService")
    .select("id")
    .where("projectId", "=", row.projectId)
    .where("kind", "=", "valkey")
    .where("deletedAt", "is", null)
    .where("status", "in", ["provisioning", "active"])
    .orderBy("createdAt", "asc")
    .executeTakeFirst()

  if (service === undefined) {
    return { problem: "This project has no queue service, so there is no namespace to look in" }
  }

  const connectionUrl = valkeyAdminUrl()
  if (connectionUrl === undefined) {
    return { problem: "Queue inspection is not configured on this deployment" }
  }

  return {
    queueJobId: row.queueJobId,
    location: { connectionUrl, backendServiceId: service.id, queueName: row.queueName },
  }
}

async function ownedWorkflow(organizationId: string, workflowId: string) {
  return await db
    .selectFrom("workflow")
    .innerJoin("project", "project.id", "workflow.projectId")
    // `enabled` joined here rather than re-queried by the one caller that needs it: every caller
    // of this helper is about to act on the workflow, and a disabled one is a thing none of them
    // should act on.
    .select([
      "workflow.id as id",
      "workflow.projectId as projectId",
      "workflow.currentVersionId as currentVersionId",
      "workflow.enabled as enabled",
    ])
    .where("workflow.id", "=", workflowId)
    .where("project.organizationId", "=", organizationId)
    .where("workflow.deletedAt", "is", null)
    .where("project.deletedAt", "is", null)
    .executeTakeFirst()
}

type RunRow = {
  id: string
  status: string
  // `jsonb`, so `unknown`. Narrowed by `presentRunError` rather than trusted.
  error: unknown
  triggerType: string
  queueJobId: string | null
  bytesEnqueued: unknown
  valkeyDwellMs: unknown
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

function presentRun(run: RunRow) {
  return {
    id: run.id,
    status: run.status,
    // Narrowed rather than passed through: `error` is `jsonb`, so anything could be in it, and the
    // schema promises `{code, message}`. A row written by an older runner keeps its status and
    // loses only the explanation, which beats failing the whole response.
    error: presentRunError(run.error),
    triggerType: run.triggerType,
    queueJobId: run.queueJobId,
    // bigint columns arrive as strings and leave as strings — a run that queued four gigabytes is
    // past what a JSON number holds exactly.
    bytesEnqueued: presentInt8(run.bytesEnqueued),
    valkeyDwellMs: presentInt8(run.valkeyDwellMs),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  }
}

/** A nullable bigint column as JSON, refusing an unexpected driver value instead of stringifying it. */
function presentInt8(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : null
}

/** `workflow_run.error` as the schema promises it, or null for anything that is not that shape. */
function presentRunError(raw: unknown): { code: string; message: string } | null {
  if (raw === null || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.code !== "string" || typeof value.message !== "string") return null
  return { code: value.code, message: value.message }
}

function elapsedSeconds(from: Date | null, to: Date | null): number {
  if (from === null || to === null) return 0
  return Math.max(0, (to.getTime() - from.getTime()) / 1000)
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

export { sql }
export default app
