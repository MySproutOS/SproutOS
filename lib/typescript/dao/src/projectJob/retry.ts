import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import { initialSteps, type ProjectJobKind } from "./crud"

export type RetryProvisionResult = {
  job: Selectable<DB["projectJob"]>
  enqueued: boolean
}

export async function retryFailedProvision(
  db: Kysely<DB>,
  input: {
    organizationId: string
    projectId: string
    projectJobId: string
    userId: string
  },
): Promise<RetryProvisionResult | undefined> {
  return await db.transaction().execute(async (tx) => {
    const prior = await tx
      .selectFrom("projectJob")
      .innerJoin("repository", "repository.id", "projectJob.repositoryId")
      .innerJoin("project", "project.id", "projectJob.projectId")
      .select([
        "projectJob.id",
        "projectJob.kind",
        "projectJob.state",
        "projectJob.attempt",
        "repository.githubRepoId",
        "project.state as projectState",
      ])
      .where("projectJob.id", "=", input.projectJobId)
      .where("projectJob.organizationId", "=", input.organizationId)
      .where("projectJob.projectId", "=", input.projectId)
      .where("projectJob.kind", "in", ["provision", "fork"])
      .whereRef("project.repositoryId", "=", "repository.id")
      .where("project.deletedAt", "is", null)
      .where("repository.deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst()

    if (prior === undefined || BigInt(prior.githubRepoId) <= 0n) return undefined
    if (
      (prior.state === "queued" || prior.state === "running") &&
      prior.projectState === "provisioning"
    ) {
      const job = await tx
        .selectFrom("projectJob")
        .selectAll()
        .where("id", "=", prior.id)
        .executeTakeFirstOrThrow()
      return { job, enqueued: false }
    }
    if (prior.state !== "failed" || prior.projectState !== "failed") return undefined

    const attempt = prior.attempt + 1
    const kind = prior.kind as ProjectJobKind
    const now = new Date()
    const job = await tx
      .updateTable("projectJob")
      .set({
        state: "queued",
        progress: 0,
        attempt,
        errorCode: null,
        errorMessage: null,
        steps: JSON.stringify(initialSteps(kind)),
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where("id", "=", prior.id)
      .where("state", "=", "failed")
      .returningAll()
      .executeTakeFirst()
    if (job === undefined) return undefined

    await tx
      .updateTable("project")
      .set({ state: "provisioning", stateReason: null, updatedAt: now })
      .where("id", "=", input.projectId)
      .where("organizationId", "=", input.organizationId)
      .execute()

    await tx
      .insertInto("backgroundJob")
      .values({
        id: v7(),
        organizationId: input.organizationId,
        kind: "project.provision",
        payload: JSON.stringify({ projectJobId: prior.id, userId: input.userId }),
        idempotencyKey: `project.provision:retry:${prior.id}:${attempt}`,
        maxAttempts: 5,
      })
      .execute()

    return { job, enqueued: true }
  })
}
