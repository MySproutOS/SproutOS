import { crudMeteringOutbox } from "@lib/dao"
import { encodeUsageEvent, usageEventRecord } from "@lib/metering"
import type { DB, JsonValue } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"

/** The workflow executor's currently published allocation. Keep the UI estimate on these values. */
export const WORKFLOW_EXEC_VCPU = 1
export const WORKFLOW_EXEC_GIB = 0.5

type WorkflowExecution = {
  runId: string
  workflowId: string
  organizationId: string
  projectId: string
  startedAt: Date
  finishedAt: Date
}

/**
 * Durable execution usage for one terminal workflow run.
 *
 * A run is one allocation held from its successful claim through its terminal update. Millisecond
 * timestamps are the control plane's authoritative clock. A sub-millisecond-looking run is billed
 * as one millisecond because Postgres/JavaScript timestamps cannot represent a smaller observed
 * interval; emitting zero would falsely mean no work was observed.
 */
export function workflowExecutionOutboxRecords(
  input: WorkflowExecution,
): { eventId: string; payload: JsonValue }[] {
  const milliseconds = Math.max(1, input.finishedAt.getTime() - input.startedAt.getTime())
  const seconds = milliseconds / 1000

  return [
    executionRecord(input, "workflow_exec_vcpu_second", seconds * WORKFLOW_EXEC_VCPU),
    executionRecord(input, "workflow_exec_gib_second", seconds * WORKFLOW_EXEC_GIB),
  ]
}

/** Insert both dimensions in the caller's terminal-state transaction. */
export async function recordWorkflowExecution(
  db: Kysely<DB> | Transaction<DB>,
  input: WorkflowExecution,
): Promise<void> {
  await Promise.all(
    workflowExecutionOutboxRecords(input).map(async (record) => {
      await crudMeteringOutbox(db).create({
        id: v7(),
        eventId: record.eventId,
        payload: record.payload,
      })
    }),
  )
}

function executionRecord(
  input: WorkflowExecution,
  dimension: "workflow_exec_vcpu_second" | "workflow_exec_gib_second",
  quantity: number,
): { eventId: string; payload: JsonValue } {
  const event = usageEventRecord({
    organizationId: input.organizationId,
    projectId: input.projectId,
    resourceType: "workflow_run",
    resourceId: input.runId,
    dimension,
    quantity: quantity.toFixed(9),
    occurredAt: input.finishedAt,
    ingestedAt: input.finishedAt,
    version: String(input.finishedAt.getTime()),
    windowStart: input.startedAt,
    windowEnd: input.finishedAt,
    nodeId: null,
    podUid: null,
    source: "workflow",
    externalId: `${input.runId}:${dimension}`,
    chargedExternally: false,
    attributes: { workflow_id: input.workflowId },
  })

  return {
    eventId: event.eventId,
    payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
  }
}
