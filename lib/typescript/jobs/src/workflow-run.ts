import type { DB } from "@sproutos/db"
import { NODE_RUNTIME, plannedSteps, type WorkflowGraph } from "@lib/workflows"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
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
 * So those steps are recorded as `blocked`, with the reason, and the run finishes `blocked` rather
 * than `succeeded`. That is an honest state: the platform knows what the workflow wanted to do and
 * says why it did not. Marking them succeeded would be the `project_job` bug again — a run that
 * reports success for work nobody did — and executing them here would be worse than either.
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

  let blocked = 0

  for (const step of steps) {
    const runtime = NODE_RUNTIME[step.nodeType as keyof typeof NODE_RUNTIME]

    if (runtime === "sandbox") {
      blocked += 1
      await db
        .updateTable("workflowRunStep")
        .set({
          status: "blocked",
          finishedAt: new Date(),
          output: JSON.stringify({
            reason: `${step.nodeType} needs an isolated runtime`,
            detail:
              "This node carries a customer-supplied destination or customer-supplied code, and " +
              "the job worker holds the control plane's credentials and is not under the tenant " +
              "NetworkPolicy. It runs in a Kata sandbox, which is not yet wired to this queue.",
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

  /*
    `blocked`, not `succeeded`, when anything was.

    A run whose only executed steps were the trigger and a delay did not do what the workflow says
    it does, and a green run list would be the most misleading thing this feature could show.
  */
  await db
    .updateTable("workflowRun")
    .set({
      status: blocked > 0 ? "blocked" : "succeeded",
      finishedAt: new Date(),
      updatedAt: new Date(),
      error:
        blocked > 0
          ? JSON.stringify({
              code: "SandboxUnavailable",
              message: `${blocked} of ${steps.length} steps need an isolated runtime that is not wired yet`,
            })
          : null,
    })
    .where("id", "=", claimed.id)
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
    input: JSON.stringify({}),
  }))
}

export const workflowRunJob: JobHandler = async (job, { db, signal }) => {
  await runWorkflow(db, job.payload as WorkflowRunPayload, signal)
}
