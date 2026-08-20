import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

export type WorkflowStatus = "healthy" | "degraded" | "paused" | "failing"

export type Workflow = {
  id: string
  name: string
  project: string
  schedule: string
  status: WorkflowStatus
  lastRunLabel: string
  costMicros: bigint
}

export type Job = {
  id: string
  workflow: string
  duration: string
  costMicros: bigint
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  paused: "Paused",
  failing: "Failing",
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugWorkflowOptions(...)`. */
export function useWorkflows(orgSlug: string) {
  const workflows: Workflow[] = [
    {
      id: "wfl_01j8nightlyindex",
      name: "Nightly reindex",
      project: "Message Search",
      schedule: "0 3 * * *",
      status: "healthy",
      lastRunLabel: "6 hours ago",
      costMicros: 940_000n,
    },
    {
      id: "wfl_01j8followupsweep",
      name: "Follow-up sweep",
      project: "Client Follow-ups",
      schedule: "*/15 * * * *",
      status: "degraded",
      lastRunLabel: "4 minutes ago",
      costMicros: 220_000n,
    },
    {
      id: "wfl_01j8digestsend",
      name: "Digest send",
      project: "Weekly Digest",
      schedule: "0 9 * * 1",
      status: "paused",
      lastRunLabel: "12 days ago",
      costMicros: 0n,
    },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "workflows"], workflows)
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugJobOptions(...)`. */
export function useRecentJobs(orgSlug: string) {
  const jobs: Job[] = [
    { id: "job_01j8h2q4", workflow: "Nightly reindex", duration: "1m 42s", costMicros: 41_200n },
    { id: "job_01j8h2q3", workflow: "Follow-up sweep", duration: "0m 08s", costMicros: 3_100n },
    { id: "job_01j8h2q2", workflow: "Follow-up sweep", duration: "0m 07s", costMicros: 2_900n },
    { id: "job_01j8h2q1", workflow: "Digest send", duration: "0m 51s", costMicros: 10_400n },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "jobs"], jobs)
}
