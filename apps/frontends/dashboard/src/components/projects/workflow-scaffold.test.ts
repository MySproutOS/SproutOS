import { describe, expect, it } from "vitest"
import { type WorkflowStack, WORKFLOW_STACKS, workflowAgentPrompt } from "./workflow-scaffold"

const WORKFLOW_CASES: [WorkflowStack, string][] = [
  ["bullmq-typescript", "official bullmq package"],
  ["bullmq-rust", "official bullmq-official crate"],
  ["celery-python", "Celery with Python"],
]

describe("workflow scaffold choices", () => {
  it("offers each supported language and queue combination exactly once", () => {
    expect(WORKFLOW_STACKS.map((stack) => stack.value)).toEqual([
      "bullmq-typescript",
      "bullmq-rust",
      "celery-python",
    ])
  })

  it.each(WORKFLOW_CASES)("gives the agent an unambiguous %s scaffold", (stack, expected) => {
    const prompt = workflowAgentPrompt("webhook", stack)

    expect(prompt).toContain(expected)
    expect(prompt).toContain("Attach a Valkey queue to this workflow project")
    expect(prompt).toContain("status endpoint")
  })
})
