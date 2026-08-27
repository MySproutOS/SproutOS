import { describe, expect, it } from "vitest"
import { workflowJobsOutboxRecord } from "./workflow-metering"

const input = {
  runId: "01990a1d-a9ea-7000-8000-000000000001",
  workflowId: "01990a1d-a9ea-7000-8000-000000000002",
  workflowVersionId: "01990a1d-a9ea-7000-8000-000000000003",
  organizationId: "01990a1d-a9ea-7000-8000-000000000004",
  projectId: "01990a1d-a9ea-7000-8000-000000000005",
  jobs: 7,
  occurredAt: new Date("2026-08-27T12:00:00.123Z"),
}

describe("workflowJobsOutboxRecord", () => {
  it("uses the run identity, exact step count, and original timestamp", () => {
    const record = workflowJobsOutboxRecord(input)
    const payload = record?.payload as Record<string, unknown>

    expect(payload.dimension).toBe("workflow_job_enqueued")
    expect(payload.quantity).toBe("7")
    expect(payload.external_id).toBe(`${input.runId}:workflow_job_enqueued`)
    expect(payload.occurred_at).toBe("2026-08-27 12:00:00.123")
    expect(payload.organization_id).toBe(input.organizationId)
    expect(payload.project_id).toBe(input.projectId)
    expect(record?.eventId).toMatch(/^[0-9a-f]{64}$/)

    // Retrying the transaction with its original observation reproduces the same dedupe key.
    expect(workflowJobsOutboxRecord({ ...input })).toEqual(record)
  })

  it("does not turn an empty plan into a zero usage event", () => {
    expect(workflowJobsOutboxRecord({ ...input, jobs: 0 })).toBeUndefined()
  })
})
