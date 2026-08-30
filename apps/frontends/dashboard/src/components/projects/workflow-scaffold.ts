export type WorkflowStack = "bullmq-typescript" | "bullmq-rust" | "celery-python"

export const WORKFLOW_STACKS: {
  value: WorkflowStack
  label: string
  detail: string
  agentInstruction: string
}[] = [
  {
    value: "bullmq-typescript",
    label: "BullMQ · TypeScript",
    detail: "Node.js and the official BullMQ package.",
    agentInstruction: "BullMQ with TypeScript and the official bullmq package",
  },
  {
    value: "bullmq-rust",
    label: "BullMQ · Rust",
    detail: "Rust with the official BullMQ-compatible crate.",
    agentInstruction: "BullMQ with Rust and the official bullmq-official crate",
  },
  {
    value: "celery-python",
    label: "Celery · Python",
    detail: "Python and Celery with Valkey as broker and result backend.",
    agentInstruction: "Celery with Python and Valkey as both broker and result backend",
  },
]

export function workflowAgentPrompt(trigger: "interval" | "webhook", stack: WorkflowStack): string {
  const selected = WORKFLOW_STACKS.find((candidate) => candidate.value === stack)
  if (selected === undefined) throw new Error(`Unknown workflow stack: ${stack}`)

  return `Create a ${trigger} workflow in this repository using ${selected.agentInstruction}. Attach a Valkey queue to this workflow project and use the injected queue connection variable rather than hard-coded credentials. Include environment variable documentation, structured logs, observable failure handling, and a small status endpoint that proves a real job completed.`
}
