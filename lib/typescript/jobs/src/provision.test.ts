import { describe, expect, it } from "vitest"
import { PROJECT_JOB_STEPS, initialSteps } from "@lib/dao/projectJob/crud"

/*
  The step list is the customer-visible progress record, and until `provision.ts` existed nothing
  moved a step out of `pending`. These assert the shape the executor depends on — a key it does not
  recognise would leave a step stuck and the progress bar short of 100 with no error.
*/
describe("project job steps", () => {
  it("starts every step pending, which is what the executor claims and advances", () => {
    expect(initialSteps("fork").every((step) => step.state === "pending")).toBe(true)
  })

  it("names the creation step the executor marks, per kind", () => {
    // `provision.ts` picks `fork_repository` or `create_repository` from the job's kind. A rename
    // on either side would silently leave the step pending and the job at 0% while succeeding.
    expect(PROJECT_JOB_STEPS.fork.map((step) => step.key)).toContain("fork_repository")
    expect(PROJECT_JOB_STEPS.provision.map((step) => step.key)).toContain("create_repository")
  })

  it("has no kind whose steps are empty, which would divide by zero computing progress", () => {
    // Asserted as a map so a failure names the offending kind. `expect(n, kind)` would be the
    // obvious way to say that and vitest's matcher takes one argument.
    const counts = Object.fromEntries(
      Object.entries(PROJECT_JOB_STEPS).map(([kind, steps]) => [kind, steps.length > 0]),
    )
    expect(counts).toEqual({ fork: true, provision: true, sync_upstream: true, delete: true })
  })
})
