import { useQuery } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugWorkflowRunsOptions,
  getV1OrgsByOrgSlugWorkflowsOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { relativeLabel } from "@frontends/dashboard/data/projects"

export type WorkflowStatus = "healthy" | "degraded" | "paused" | "failing"

export type Workflow = {
  id: string
  name: string
  project: string
  projectId: string
  schedule: string
  status: WorkflowStatus
  lastRunLabel: string
  costMicros: bigint
}

export type Job = {
  id: string
  workflowId: string
  projectId: string
  workflow: string
  duration: string
  /** Null while one of the run's billable dimensions has never been measured. */
  costMicros: bigint | null
  status: string
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  paused: "Paused",
  failing: "Failing",
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return value in WORKFLOW_STATUS_LABELS
}

/**
 * A duration as `1m 42s`.
 *
 * Null while a run is still going: "so far" is not something a table column can say, and a
 * stopwatch that ticks in a list is a promise to keep it up to date.
 */
export function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null) return "—"
  const total = Math.max(0, Math.round(milliseconds / 1000))
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
}

/**
 * Every workflow in the organization.
 *
 * `schedule` is an em dash rather than "manual" when nothing schedules it: a workflow can be
 * triggered by webhook, by an event, or by hand, and calling all three "manual" would be a claim
 * this list has no way to check.
 */
export function useWorkflows(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugWorkflowsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((workflow): Workflow => ({
      id: workflow.id,
      name: workflow.name,
      project: workflow.projectName,
      projectId: workflow.projectId,
      schedule: workflow.cronExpression ?? "—",
      status: isWorkflowStatus(workflow.health) ? workflow.health : "healthy",
      lastRunLabel: workflow.lastRunAt === null ? "Never run" : relativeLabel(workflow.lastRunAt),
      // Money is bigint, never a float — see `@lib/billing`.
      costMicros: BigInt(workflow.costMicroUsd),
    })),
  }
}

/** Recent runs across the organization, newest first. */
export function useRecentJobs(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugWorkflowRunsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((run): Job => ({
      id: run.id,
      workflowId: run.workflowId,
      projectId: run.projectId,
      workflow: run.workflowName,
      duration: durationLabel(run.durationMs),
      costMicros: run.costMicroUsd === null ? null : BigInt(run.costMicroUsd),
      status: run.status,
    })),
  }
}
