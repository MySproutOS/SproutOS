import type { DB } from "@sproutos/db"
import { NODE_RUNTIME, plannedSteps, type WorkflowGraph } from "@lib/workflows"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { tenantNamespace } from "./deploy"
import { runNodeInSandbox } from "./sandbox-node"
import { sleep } from "./sleep"
import type { JobHandler } from "./worker"

/**
 * Running a workflow.
 *
 * **`workflow_run` was read in five places and written by nothing** — the runs list, the run
 * detail, the run's queued job, the step counter and the cross-project feed all queried a table no
 * code in either language inserted into. A customer could build a graph, save a version, and watch
 * an empty run list forever.
 *
 * What this does *not* do is the important half. Four of the ten node types — `action.http`,
 * `action.code`, `action.database`, `action.email` — carry a customer-supplied destination or
 * customer-supplied source, and this process is the job worker: it holds the control-plane database
 * URL, the envelope KMS key, the GitHub App credentials and a Kubernetes service account, and it is
 * not under `deploy/tenant/network-policy.yaml`. Fetching a URL a customer typed, from here,
 * reaches the API server, every tenant's database, and `169.254.169.254`.
 *
 * They run in a **sandbox**: a Job in the tenant's own namespace, where
 * `deploy/tenant/network-policy.yaml` denies by default and excludes every private range from
 * egress, with no service-account token, no root, no capabilities and a deadline Kubernetes
 * enforces. See `@lib/sandbox`.
 *
 * When there is no tenant namespace to run in — a workflow whose project was never provisioned —
 * they are recorded as `skipped`, with the reason in `output`, and the run finishes `failed`
 * rather than `succeeded`. That is an honest state: the platform knows what the workflow
 * wanted to do and says why it did not. Marking them succeeded would be the `project_job` bug again
 * — a run that reports success for work nobody did — and executing them here would be worse.
 *
 * `skipped` and `failed` because those are the words the schema permits.
 * `workflow_run_step_status_check` allows queued/running/succeeded/failed/skipped and
 * `workflow_run_status_check` allows queued/running/succeeded/failed/dead_lettered/cancelled. The
 * first version of this wrote `blocked`, which is a better word and is not one of them: every
 * update threw, the job failed, and the run was stranded in `running` with two finished steps and
 * a third that never moved. Postgres was right and the code was wrong, and the way it presented
 * was a workflow that hung.
 */
export const WORKFLOW_RUN_KIND = "workflow.run"

export type WorkflowRunPayload = { workflowRunId: string }

/** How long a `control.delay` may hold a worker. Longer belongs to a scheduler, not a held lease. */
export const MAX_DELAY_MS = 30_000

/** `control.delay`'s configured wait, clamped, and 0 when it is not a usable number. */
export function delayMs(config: Record<string, unknown>): number {
  const raw = config.ms ?? config.milliseconds ?? config.delayMs
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, MAX_DELAY_MS)
}

/**
 * Execute one run's steps in order.
 *
 * Sequential rather than concurrent even where the graph allows it. A workflow's steps are almost
 * always dependent, the concurrency would be bounded by the same worker anyway, and a parallel
 * executor whose only tested path is the serial one is a parallel executor that has not been
 * tested.
 */
export async function runWorkflow(
  db: Kysely<DB>,
  payload: WorkflowRunPayload,
  signal?: AbortSignal,
): Promise<void> {
  const claimed = await db
    .updateTable("workflowRun")
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where("id", "=", payload.workflowRunId)
    .where("status", "=", "queued")
    .returningAll()
    .executeTakeFirst()

  // Already running or finished: the runner retries, and a retry must not re-run completed steps.
  if (claimed === undefined) return

  const steps = await db
    .selectFrom("workflowRunStep")
    .selectAll()
    .where("workflowRunId", "=", claimed.id)
    // `id` is a UUIDv7 minted in planning order, so this is the topological order the plan chose.
    // Ordering by `created_at` would be the obvious alternative and is wrong: rows written in one
    // statement share a timestamp, and the tie-break would be arbitrary.
    .orderBy("id")
    .execute()

  let skipped = 0
  let failedStep = false

  /*
    Where a sandboxed node runs.

    Derived from the workflow's project, because the namespace *is* the boundary — see
    `tenantNamespace`. `undefined` when the project has never been provisioned, which is the one
    case those nodes still cannot run in.
  */
  const namespace = await tenantNamespaceFor(db, claimed.workflowId)

  try {
    for (const step of steps) {
      const runtime = NODE_RUNTIME[step.nodeType as keyof typeof NODE_RUNTIME]

      if (runtime === "sandbox") {
        if (namespace === undefined) {
          /*
            Nowhere safe to run it.

            The tenant namespace is the boundary — without it there is no NetworkPolicy and the only
            remaining option is this process, which is the one place this node must never run. A
            workflow on a project that was never provisioned lands here.
          */
          skipped += 1
          await db
            .updateTable("workflowRunStep")
            .set({
              status: "skipped",
              finishedAt: new Date(),
              output: JSON.stringify({
                reason: `${step.nodeType} needs a tenant namespace to run in`,
                detail:
                  "This node carries a customer-supplied destination or customer-supplied code, " +
                  "and runs in a sandbox inside the project's own namespace. This project has no " +
                  "namespace yet, so there is nowhere to run it that is not the control plane.",
              }),
            })
            .where("id", "=", step.id)
            .execute()
          continue
        }

        await db
          .updateTable("workflowRunStep")
          .set({ status: "running", startedAt: new Date() })
          .where("id", "=", step.id)
          .execute()

        const result = await runNodeInSandbox({
          namespace,
          runId: claimed.id,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          config: (step.input as Record<string, unknown> | null) ?? {},
        })

        /*
          A non-zero exit fails the step and the run. The output is recorded either way — the body
          of a failed HTTP call is usually the only thing that says what went wrong, and discarding
          it because the exit code was non-zero throws away the answer with the error.
        */
        const ok = result.exitCode === 0
        if (!ok) failedStep = true

        await db
          .updateTable("workflowRunStep")
          .set({
            status: ok ? "succeeded" : "failed",
            finishedAt: new Date(),
            output: JSON.stringify({
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              // Bounded: a step's output is read by a UI, and a customer's script can print
              // megabytes. The pod's logs are the full record while the pod exists.
              output: result.output.slice(0, 8000),
            }),
          })
          .where("id", "=", step.id)
          .execute()
        continue
      }

      await db
        .updateTable("workflowRunStep")
        .set({ status: "running", startedAt: new Date() })
        .where("id", "=", step.id)
        .execute()

      if (step.nodeType === "control.delay") {
        await sleep(delayMs((step.input as Record<string, unknown> | null) ?? {}), signal)
      }

      await db
        .updateTable("workflowRunStep")
        .set({ status: "succeeded", finishedAt: new Date() })
        .where("id", "=", step.id)
        .execute()
    }
  } catch (cause) {
    /*
      Any throw ends the run, here, rather than leaving it `running`.

      Without this the first version of this function stranded a run permanently: an update was
      rejected by a CHECK constraint, the job failed, and the run sat at `running` with two
      finished steps and a third that never moved. The job runner retried, the conditional claim at
      the top found `status <> 'queued'`, and every retry returned immediately having done nothing.
      A run that cannot finish and cannot be retried is worse than one that failed.
    */
    await failRun(db, claimed.id, {
      code: cause instanceof Error ? cause.name : "Error",
      message: cause instanceof Error ? cause.message : String(cause),
    })
    throw cause
  }

  /*
    `failed`, not `succeeded`, when anything was skipped.

    A run whose only executed steps were the trigger and a delay did not do what the workflow says
    it does, and a green run list would be the most misleading thing this feature could show.
  */
  if (skipped > 0) {
    await failRun(db, claimed.id, {
      code: "SandboxUnavailable",
      message: `${skipped} of ${steps.length} steps need a tenant namespace this project does not have`,
    })
    return
  }

  /*
    A step that exited non-zero fails the run.

    Without this the run reported `succeeded` while carrying a step marked `failed` — a green run
    list over a workflow that did not do what it says. The step's own output holds the reason; this
    is only what makes the run agree with it.
  */
  if (failedStep) {
    await failRun(db, claimed.id, {
      code: "StepFailed",
      message: "A step exited non-zero. Its output is recorded on the step.",
    })
    return
  }

  await db
    .updateTable("workflowRun")
    .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(), error: null })
    .where("id", "=", claimed.id)
    .execute()
}

/**
 * End a run as failed, with a reason on the row.
 *
 * `failed` because it is one of the six words `workflow_run_status_check` permits — queued,
 * running, succeeded, failed, dead_lettered, cancelled. The reason goes in `error`, which is what
 * the run detail renders.
 */
async function failRun(
  db: Kysely<DB>,
  runId: string,
  error: { code: string; message: string },
): Promise<void> {
  await db
    .updateTable("workflowRun")
    .set({
      status: "failed",
      finishedAt: new Date(),
      updatedAt: new Date(),
      error: JSON.stringify(error),
    })
    .where("id", "=", runId)
    .execute()
}

/** The step rows a new run starts with, in execution order. Exported for the route that creates them. */
export function stepRowsFor(
  workflowRunId: string,
  graph: WorkflowGraph,
): { id: string; workflowRunId: string; nodeId: string; nodeType: string; input: string }[] {
  return plannedSteps(graph).map((step) => ({
    // UUIDv7 in planning order, which is what `runWorkflow` orders by. See its note.
    id: v7(),
    workflowRunId,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    // The node's own configuration — the url an `action.http` fetches, the source an `action.code`
    // runs. It was `{}`, so every sandboxed node was handed nothing and `action.http` failed with
    // "needs a url" for a node that had one.
    input: JSON.stringify(step.config),
  }))
}

export const workflowRunJob: JobHandler = async (job, { db, signal }) => {
  await runWorkflow(db, job.payload as WorkflowRunPayload, signal)
}

/**
 * The namespace a workflow's sandboxed steps run in.
 *
 * `tenantNamespace` and the **organization** id, which is what `deployRevision` uses. The two have
 * to agree exactly: `deploy/tenant/network-policy.yaml` is applied to the namespace the deploy
 * created, and a sandbox in any other namespace is a sandbox with no policy on it — which is the
 * whole isolation, silently absent. Keying this on the project id instead would have produced a
 * namespace that does not exist, and the Job would have been rejected rather than unprotected,
 * which is the lucky version of that mistake.
 */
async function tenantNamespaceFor(db: Kysely<DB>, workflowId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("workflow")
    .innerJoin("project", "project.id", "workflow.projectId")
    .select(["project.organizationId as organizationId"])
    .where("workflow.id", "=", workflowId)
    .executeTakeFirst()

  return row === undefined ? undefined : tenantNamespace(row.organizationId)
}
