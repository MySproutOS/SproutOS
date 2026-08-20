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
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { sql } from "kysely"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import {
  workflowsSchemaCreateRequest,
  workflowsSchemaIdParam,
  workflowsSchemaJob,
  workflowsSchemaJobEditRequest,
  workflowsSchemaJobEditResponse,
  workflowsSchemaListResponse,
  workflowsSchemaRunDetailResponse,
  workflowsSchemaRunListResponse,
  workflowsSchemaRunParam,
  workflowsSchemaVersionRequest,
  workflowsSchemaVersionResponse,
  workflowsSchemaWorkflow,
} from "./workflows.serializer"

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
const app: Hono = new Hono()
app.use(authMiddleware)
app
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
        bytesEnqueued: BigInt(run.bytesEnqueued),
        dwellMs: BigInt(run.valkeyDwellMs),
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
    .select(["workflow.id as id", "workflow.currentVersionId as currentVersionId"])
    .where("workflow.id", "=", workflowId)
    .where("project.organizationId", "=", organizationId)
    .where("workflow.deletedAt", "is", null)
    .where("project.deletedAt", "is", null)
    .executeTakeFirst()
}

type RunRow = {
  id: string
  status: string
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
    triggerType: run.triggerType,
    queueJobId: run.queueJobId,
    // bigint columns arrive as strings and leave as strings — a run that queued four gigabytes is
    // past what a JSON number holds exactly.
    bytesEnqueued: String(run.bytesEnqueued),
    valkeyDwellMs: String(run.valkeyDwellMs),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  }
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
