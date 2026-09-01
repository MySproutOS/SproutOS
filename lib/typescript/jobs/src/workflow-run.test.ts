import { db } from "@sproutos/db"
import { sql } from "kysely"
import { beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { MAX_DELAY_MS, delayMs, runWorkflow, stepRowsFor } from "./workflow-run"

const retentionReachable = await (async () => {
  try {
    await sql`select 1 from credit_retention_state limit 0`.execute(db)
    return true
  } catch {
    return false
  }
})()

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
    const written = ["running", "succeeded", "failed", "cancelled"]
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

describe("terminal workflow usage", () => {
  let reachable = false

  beforeAll(async () => {
    try {
      await sql`select 1`.execute(db)
      reachable = true
    } catch {
      /* not reachable */
    }
  })

  it("commits the terminal state and both execution dimensions atomically", async ({ skip }) => {
    if (!reachable) skip()

    const userId = v7()
    const organizationId = v7()
    const repositoryId = v7()
    const projectId = v7()
    const workflowId = v7()
    const runId = v7()
    const suffix = runId.replaceAll("-", "")

    try {
      await db
        .insertInto("user")
        .values({
          id: userId,
          email: `workflow-meter-${suffix}@example.test`,
          name: "Workflow meter",
          isAdmin: false,
        })
        .execute()
      await db
        .insertInto("organization")
        .values({
          id: organizationId,
          slug: `workflow-meter-${suffix}`,
          name: "Workflow meter",
          kind: "team",
          ownerUserId: userId,
        })
        .execute()
      await db
        .insertInto("repository")
        .values({
          id: repositoryId,
          organizationId,
          githubRepoId: BigInt(Date.now()),
          ownerLogin: "sprout-test",
          name: `workflow-meter-${suffix}`,
          provenance: "new",
        })
        .execute()
      await db
        .insertInto("project")
        .values({
          id: projectId,
          organizationId,
          repositoryId,
          name: "Workflow meter",
          slug: `workflow-meter-${suffix}`,
        })
        .execute()
      await db
        .insertInto("workflow")
        .values({
          id: workflowId,
          projectId,
          slug: `workflow-meter-${suffix}`,
          name: "Workflow meter",
          queueName: `workflow-meter-${suffix}`,
        })
        .execute()
      await db
        .insertInto("workflowRun")
        .values({ id: runId, workflowId, triggerType: "manual", status: "queued" })
        .execute()

      await runWorkflow(db, { workflowRunId: runId })

      const run = await db
        .selectFrom("workflowRun")
        .select(["status", "startedAt", "finishedAt"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow()
      const outbox = await db
        .selectFrom("meteringOutbox")
        .select(["eventId", "payload"])
        .where(sql<boolean>`payload ->> 'resource_id' = ${runId}`)
        .orderBy(sql`payload ->> 'dimension'`)
        .execute()
      expect(run.status).toBe("succeeded")
      expect(run.startedAt).not.toBeNull()
      expect(run.finishedAt).not.toBeNull()
      expect(outbox.map((row) => (row.payload as { dimension?: string }).dimension)).toEqual([
        "workflow_exec_gib_second",
        "workflow_exec_vcpu_second",
      ])
    } finally {
      await db
        .deleteFrom("meteringOutbox")
        .where(sql<boolean>`payload ->> 'resource_id' = ${runId}`)
        .execute()
      await db.deleteFrom("workflowRun").where("id", "=", runId).execute()
      await db.deleteFrom("workflow").where("id", "=", workflowId).execute()
      await db.deleteFrom("project").where("id", "=", projectId).execute()
      await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
      await db.deleteFrom("organization").where("id", "=", organizationId).execute()
      await db.deleteFrom("user").where("id", "=", userId).execute()
    }
  })

  it("cancels a queued run before execution when credit is suspended", async ({ skip }) => {
    if (!reachable || !retentionReachable) skip()

    const userId = v7()
    const organizationId = v7()
    const repositoryId = v7()
    const projectId = v7()
    const workflowId = v7()
    const runId = v7()
    const suffix = runId.replaceAll("-", "")

    try {
      await db
        .insertInto("user")
        .values({ id: userId, email: `workflow-suspended-${suffix}@example.test` })
        .execute()
      await db
        .insertInto("organization")
        .values({
          id: organizationId,
          slug: `workflow-suspended-${suffix}`,
          name: "Suspended workflow",
          kind: "team",
          ownerUserId: userId,
        })
        .execute()
      await db
        .insertInto("repository")
        .values({
          id: repositoryId,
          organizationId,
          githubRepoId: BigInt(Date.now()),
          ownerLogin: "sprout-test",
          name: `workflow-suspended-${suffix}`,
          provenance: "new",
        })
        .execute()
      await db
        .insertInto("project")
        .values({
          id: projectId,
          organizationId,
          repositoryId,
          name: "Suspended workflow",
          slug: `workflow-suspended-${suffix}`,
        })
        .execute()
      await db
        .insertInto("workflow")
        .values({
          id: workflowId,
          projectId,
          slug: `workflow-suspended-${suffix}`,
          name: "Suspended workflow",
          queueName: `workflow-suspended-${suffix}`,
        })
        .execute()
      await db
        .insertInto("workflowRun")
        .values({ id: runId, workflowId, triggerType: "manual", status: "queued" })
        .execute()
      await db
        .insertInto("creditRetentionState")
        .values({
          organizationId,
          generation: v7(),
          status: "suspended",
          warningStage: "suspended",
          exhaustedAt: new Date(),
          deleteAfter: new Date(Date.now() + 48 * 60 * 60 * 1000),
        })
        .execute()

      await runWorkflow(db, { workflowRunId: runId })

      const run = await db
        .selectFrom("workflowRun")
        .select(["status", "startedAt", "finishedAt", "error"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow()
      expect(run.status).toBe("cancelled")
      expect(run.startedAt).toBeNull()
      expect(run.finishedAt).not.toBeNull()
      expect(run.error).toEqual({
        code: "InsufficientCredit",
        message:
          "The run was not started because the organization is suspended for insufficient credit.",
      })
      const outboxCount = await db
        .selectFrom("meteringOutbox")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where(sql<boolean>`payload ->> 'resource_id' = ${runId}`)
        .executeTakeFirstOrThrow()
      expect(Number(outboxCount.count)).toBe(0)
    } finally {
      await db
        .deleteFrom("meteringOutbox")
        .where(sql<boolean>`payload ->> 'resource_id' = ${runId}`)
        .execute()
      await db
        .deleteFrom("creditRetentionState")
        .where("organizationId", "=", organizationId)
        .execute()
      await db.deleteFrom("workflowRun").where("id", "=", runId).execute()
      await db.deleteFrom("workflow").where("id", "=", workflowId).execute()
      await db.deleteFrom("project").where("id", "=", projectId).execute()
      await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
      await db.deleteFrom("organization").where("id", "=", organizationId).execute()
      await db.deleteFrom("user").where("id", "=", userId).execute()
    }
  })
})
