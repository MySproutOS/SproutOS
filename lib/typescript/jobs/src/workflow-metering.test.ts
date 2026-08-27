import { describe, expect, it } from "vitest"
import type { JsonObject, JsonValue } from "@sproutos/db"
import {
  WORKFLOW_EXEC_GIB,
  WORKFLOW_EXEC_VCPU,
  workflowExecutionOutboxRecords,
} from "./workflow-metering"

describe("workflow execution metering", () => {
  const base = {
    runId: "0191a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b",
    workflowId: "0191a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5c",
    organizationId: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
    projectId: "01912d41-0000-7000-8000-0000000000b1",
    startedAt: new Date("2026-08-27T01:00:00.000Z"),
    finishedAt: new Date("2026-08-27T01:00:02.500Z"),
  }

  it("records the published allocation over the observed wall-clock interval", () => {
    const records = workflowExecutionOutboxRecords(base).map(({ payload }) => object(payload))

    expect(WORKFLOW_EXEC_VCPU).toBe(1)
    expect(WORKFLOW_EXEC_GIB).toBe(0.5)
    expect(records.map((record) => [record.dimension, record.quantity])).toEqual([
      ["workflow_exec_vcpu_second", "2.500000000"],
      ["workflow_exec_gib_second", "1.250000000"],
    ])
    expect(records.every((record) => record.resource_type === "workflow_run")).toBe(true)
    expect(records.every((record) => record.window_start === "2026-08-27 01:00:00.000")).toBe(true)
    expect(records.every((record) => record.window_end === "2026-08-27 01:00:02.500")).toBe(true)
  })

  it("is retry-stable and never turns an observed run into a zero event", () => {
    const first = workflowExecutionOutboxRecords(base)
    const second = workflowExecutionOutboxRecords(base)
    expect(second).toEqual(first)

    const instantaneous = workflowExecutionOutboxRecords({ ...base, finishedAt: base.startedAt })
    expect(instantaneous.map(({ payload }) => object(payload).quantity)).toEqual([
      "0.001000000",
      "0.000500000",
    ])
  })
})

function object(value: JsonValue): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an encoded usage object")
  }
  return value
}
