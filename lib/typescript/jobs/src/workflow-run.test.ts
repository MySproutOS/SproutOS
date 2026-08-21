import { db } from "@sproutos/db"
import { sql } from "kysely"
import { beforeAll, describe, expect, it } from "vitest"
import { MAX_DELAY_MS, delayMs, stepRowsFor } from "./workflow-run"

describe("delayMs", () => {
  it("takes any of the three spellings a node config might use", () => {
    expect(delayMs({ ms: 100 })).toBe(100)
    expect(delayMs({ milliseconds: 100 })).toBe(100)
    expect(delayMs({ delayMs: 100 })).toBe(100)
  })

  it("accepts a numeric string, which is what a form field produces", () => {
    expect(delayMs({ ms: "250" })).toBe(250)
  })

  it("is zero for anything unusable, rather than NaN into a timer", () => {
    expect(delayMs({})).toBe(0)
    expect(delayMs({ ms: "soon" })).toBe(0)
    expect(delayMs({ ms: -5 })).toBe(0)
  })

  it("clamps, so a node cannot hold a worker for an hour on a job lease", () => {
    expect(delayMs({ ms: 60 * 60 * 1000 })).toBe(MAX_DELAY_MS)
  })
})

describe("stepRowsFor", () => {
  it("mints ids in execution order, which is what the executor orders by", () => {
    const rows = stepRowsFor("01a00000-0000-7000-8000-000000000000", {
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", config: {} },
        { id: "a", type: "control.delay", name: "Wait", config: {} },
      ],
      edges: [{ from: "t", to: "a" }],
    })
    expect(rows.map((row) => row.nodeId)).toEqual(["t", "a"])
    // UUIDv7 sorts lexicographically by mint time, which is the property `order by id` relies on.
    expect(rows.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id))
  })
})

/*
  The statuses this executor writes have to be ones the database permits.

  They were not. The first version wrote `blocked` — a better word for what happens, and not one of
  the five `workflow_run_step_status_check` allows — so every update threw, the job failed, and the
  run was stranded at `running` with a step that never moved. The conditional claim then made every
  retry a no-op, so it could not even fail properly.

  Read out of `pg_constraint` rather than hard-coded here, because a hard-coded copy of a constraint
  is a second place for the vocabulary to drift.
*/
describe("the status vocabulary", () => {
  let reachable = false
  let allowed: { run: string[]; step: string[] } = { run: [], step: [] }

  beforeAll(async () => {
    try {
      const rows = await sql<{ conname: string; def: string }>`
        select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid in ('workflow_run'::regclass, 'workflow_run_step'::regclass)
          and contype = 'c'
      `.execute(db)
      reachable = true

      const values = (name: string) =>
        [
          ...(rows.rows.find((row) => row.conname === name)?.def.matchAll(/'([a-z_]+)'/g) ?? []),
        ].map((match) => match[1])

      allowed = {
        run: values("workflow_run_status_check"),
        step: values("workflow_run_step_status_check"),
      }
    } catch {
      /* not reachable */
    }
  })

  it("writes only run statuses the check constraint allows", ({ skip }) => {
    if (!reachable) skip()
    // Every status `runWorkflow` can set on a run. Asserted as a subset in one comparison so a
    // failure names the offending status; vitest's matcher takes one argument, so a per-status
    // label is not available.
    const written = ["running", "succeeded", "failed"]
    expect(written.filter((status) => !allowed.run.includes(status))).toEqual([])
  })

  it("writes only step statuses the check constraint allows", ({ skip }) => {
    if (!reachable) skip()
    const written = ["running", "succeeded", "skipped"]
    expect(written.filter((status) => !allowed.step.includes(status))).toEqual([])
  })

  it("does not allow the word the first version used, which is why this test exists", ({
    skip,
  }) => {
    if (!reachable) skip()
    expect(allowed.step).not.toContain("blocked")
  })
})
