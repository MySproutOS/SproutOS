import type { JsonValue } from "@sproutos/db"
import { encodeUsageEvent, usageEventRecord } from "@lib/metering"

/**
 * The exact job count known when a workflow run is created.
 *
 * A dispatcher wake is not a job: the Valkey proxy deliberately coalesces any number of enqueues
 * for one queue into one wake, and one worker invocation may drain up to 25 jobs. The planned step
 * rows are the product's existing definition of jobs for a run, so this is the first boundary that
 * knows the billable quantity without guessing.
 */
export function workflowJobsOutboxRecord(input: {
  runId: string
  workflowId: string
  workflowVersionId: string
  organizationId: string
  projectId: string
  jobs: number
  occurredAt: Date
}): { eventId: string; payload: JsonValue } | undefined {
  if (input.jobs <= 0) return undefined

  const event = usageEventRecord({
    organizationId: input.organizationId,
    projectId: input.projectId,
    resourceType: "workflow_run",
    resourceId: input.runId,
    dimension: "workflow_job_enqueued",
    quantity: String(input.jobs),
    occurredAt: input.occurredAt,
    // Retry the transaction with the exact same wire record, not merely the same event id.
    ingestedAt: input.occurredAt,
    version: String(input.occurredAt.getTime()),
    windowStart: null,
    windowEnd: null,
    nodeId: null,
    podUid: null,
    source: "workflow",
    externalId: `${input.runId}:workflow_job_enqueued`,
    chargedExternally: false,
    attributes: {
      workflow_id: input.workflowId,
      workflow_version_id: input.workflowVersionId,
    },
  })

  return {
    eventId: event.eventId,
    payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
  }
}
