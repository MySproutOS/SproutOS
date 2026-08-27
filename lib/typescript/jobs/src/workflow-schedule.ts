/* oxlint-disable no-await-in-loop -- each schedule is advanced in the same serial transaction */
import { crudMeteringOutbox } from "@lib/dao"
import { nextCronAt, type WorkflowGraph } from "@lib/workflows"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import { stepRowsFor, WORKFLOW_RUN_KIND } from "./workflow-run"
import { workflowJobsOutboxRecord } from "./workflow-metering"

/** Atomically claim due schedules, create their runs, and advance them past `now`. */
export async function runDueWorkflowSchedules(
  db: Kysely<DB>,
  now = new Date(),
  limit = 100,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const due = await tx
      .selectFrom("workflowSchedule")
      .innerJoin("workflow", "workflow.id", "workflowSchedule.workflowId")
      .innerJoin("project", "project.id", "workflow.projectId")
      .innerJoin("workflowVersion", "workflowVersion.id", "workflow.currentVersionId")
      .select([
        "workflowSchedule.id as scheduleId",
        "workflowSchedule.workflowId",
        "workflowSchedule.cronExpression",
        "workflowSchedule.timezone",
        "workflowSchedule.nextRunAt",
        "workflowVersion.id as versionId",
        "workflowVersion.graph",
        "project.id as projectId",
        "project.organizationId",
      ])
      .where("workflowSchedule.enabled", "=", true)
      .where("workflow.enabled", "=", true)
      .where("workflowSchedule.nextRunAt", "<=", now)
      .orderBy("workflowSchedule.nextRunAt")
      .limit(limit)
      .forUpdate("workflowSchedule")
      .skipLocked()
      .execute()

    for (const schedule of due) {
      const scheduledAt = schedule.nextRunAt
      if (scheduledAt === null) continue
      const runId = v7()
      const steps = stepRowsFor(runId, schedule.graph as WorkflowGraph)
      await tx
        .insertInto("workflowRun")
        .values({
          id: runId,
          workflowId: schedule.workflowId,
          workflowVersionId: schedule.versionId,
          triggerType: "cron",
          status: "queued",
          createdAt: now,
        })
        .execute()
      if (steps.length > 0) await tx.insertInto("workflowRunStep").values(steps).execute()

      const usage = workflowJobsOutboxRecord({
        runId,
        workflowId: schedule.workflowId,
        workflowVersionId: schedule.versionId,
        organizationId: schedule.organizationId,
        projectId: schedule.projectId,
        jobs: steps.length,
        occurredAt: now,
      })
      if (usage !== undefined) await crudMeteringOutbox(tx).create({ id: v7(), ...usage })

      await enqueue(tx, {
        kind: WORKFLOW_RUN_KIND,
        idempotencyKey: `${WORKFLOW_RUN_KIND}:schedule:${schedule.scheduleId}:${scheduledAt.toISOString()}`,
        payload: {
          workflowRunId: runId,
          trigger: { scheduleId: schedule.scheduleId, scheduledAt: scheduledAt.toISOString() },
        },
        maxAttempts: 3,
      })
      await tx
        .updateTable("workflowSchedule")
        .set({
          lastRunAt: scheduledAt,
          // Coalesce missed ticks: one recovery run, then the first occurrence after this scan.
          nextRunAt: nextCronAt(schedule.cronExpression, schedule.timezone, now),
          updatedAt: now,
        })
        .where("id", "=", schedule.scheduleId)
        .execute()
    }
    return due.length
  })
}
