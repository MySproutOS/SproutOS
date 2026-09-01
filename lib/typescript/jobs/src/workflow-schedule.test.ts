import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runDueWorkflowSchedules } from "./workflow-schedule"

const userId = v7()
const organizationId = v7()
const repositoryId = v7()
const projectId = v7()
const workflowId = v7()
const versionId = v7()
const scheduleId = v7()
const generation = v7()
const dueAt = new Date("2099-01-01T00:00:00.000Z")
const reachable = await (async () => {
  try {
    await sql`select 1 from credit_retention_state limit 0`.execute(db)
    return true
  } catch {
    return false
  }
})()

beforeAll(async () => {
  if (!reachable) return
  await db
    .insertInto("user")
    .values({ id: userId, email: `${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      ownerUserId: userId,
      name: "Suspended schedule",
      slug: `suspended-schedule-${organizationId.slice(-12)}`,
      kind: "team",
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "suspended-schedule",
      name: `schedule-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Suspended schedule",
      slug: `schedule-${projectId.slice(-12)}`,
    })
    .execute()
  await db
    .insertInto("workflow")
    .values({
      id: workflowId,
      projectId,
      slug: `schedule-${workflowId.slice(-12)}`,
      name: "Suspended schedule",
      queueName: `schedule-${workflowId.slice(-12)}`,
    })
    .execute()
  await db
    .insertInto("workflowVersion")
    .values({
      id: versionId,
      workflowId,
      version: 1,
      graph: {
        nodes: [{ id: "start", type: "trigger.cron", name: "Start", config: {} }],
        edges: [],
      },
      graphSha256: "a".repeat(64),
    })
    .execute()
  await db
    .updateTable("workflow")
    .set({ currentVersionId: versionId })
    .where("id", "=", workflowId)
    .execute()
  await db
    .insertInto("workflowSchedule")
    .values({
      id: scheduleId,
      workflowId,
      cronExpression: "* * * * *",
      timezone: "UTC",
      nextRunAt: dueAt,
    })
    .execute()
  await db
    .insertInto("creditRetentionState")
    .values({
      organizationId,
      generation,
      status: "suspended",
      warningStage: "suspended",
      exhaustedAt: dueAt,
      deleteAfter: new Date(dueAt.getTime() + 48 * 60 * 60 * 1000),
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("backgroundJob")
      .where("idempotencyKey", "like", `workflow.run:schedule:${scheduleId}:%`)
      .execute()
    await tx
      .deleteFrom("creditRetentionState")
      .where("organizationId", "=", organizationId)
      .execute()
    await tx.deleteFrom("workflowSchedule").where("id", "=", scheduleId).execute()
    await tx.deleteFrom("workflowVersion").where("id", "=", versionId).execute()
    await tx.deleteFrom("workflow").where("id", "=", workflowId).execute()
    await tx.deleteFrom("project").where("id", "=", projectId).execute()
    await tx.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
})

describe.skipIf(!reachable)("scheduled workflow suspension", () => {
  it("leaves a due schedule untouched until the organization is active again", async () => {
    const scanAt = new Date(dueAt.getTime() + 60_000)
    expect(await runDueWorkflowSchedules(db, scanAt)).toBe(0)
    expect(
      await db
        .selectFrom("workflowSchedule")
        .select(["nextRunAt", "lastRunAt"])
        .where("id", "=", scheduleId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ nextRunAt: dueAt, lastRunAt: null })
    const suspendedRunCount = await db
      .selectFrom("workflowRun")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workflowId", "=", workflowId)
      .executeTakeFirstOrThrow()
    expect(Number(suspendedRunCount.count)).toBe(0)

    await db
      .updateTable("creditRetentionState")
      .set({ status: "active", warningStage: "safe", exhaustedAt: null, deleteAfter: null })
      .where("organizationId", "=", organizationId)
      .execute()
    expect(await runDueWorkflowSchedules(db, scanAt)).toBe(1)
    const activeRunCount = await db
      .selectFrom("workflowRun")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workflowId", "=", workflowId)
      .executeTakeFirstOrThrow()
    expect(Number(activeRunCount.count)).toBe(1)
  })
})
