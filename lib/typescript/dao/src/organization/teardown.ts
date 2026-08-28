import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { crudProjectJob, initialSteps } from "../projectJob/crud"

export type PreparedProjectTeardown = { projectId: string; projectJobId: string }

export type PrepareOrganizationTeardownResult =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "shared"; memberCount: number }
  | { ok: true; projects: PreparedProjectTeardown[] }

export type PrepareAccountOrganizationsResult =
  | { ok: false; reason: "shared"; organizations: string[] }
  | { ok: true; projects: PreparedProjectTeardown[] }

/**
 * Atomically stop an organization accepting new work and create progress rows for every project.
 * Provider resources are removed by the durable jobs returned to the caller.
 */
export async function prepareOrganizationTeardown(
  db: Kysely<DB>,
  input: { organizationId: string; soleMemberUserId?: string },
): Promise<PrepareOrganizationTeardownResult> {
  return db.transaction().execute((tx) => prepareOne(tx, input))
}

/** Prepare every solely-owned organization together, or leave all of them untouched. */
export async function prepareAccountOrganizationsForTeardown(
  db: Kysely<DB>,
  userId: string,
): Promise<PrepareAccountOrganizationsResult> {
  return db.transaction().execute(async (tx) => {
    const organizations = await tx
      .selectFrom("organization")
      .select(["id", "slug"])
      .where("ownerUserId", "=", userId)
      .where("deletedAt", "is", null)
      .orderBy("id")
      .forUpdate()
      .execute()

    const shared: string[] = []
    for (const organization of organizations) {
      const otherMembers = await tx
        .selectFrom("organizationMember")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("organizationId", "=", organization.id)
        .where("status", "=", "active")
        .where("userId", "!=", userId)
        .executeTakeFirstOrThrow()
      if (Number(otherMembers.count) > 0) shared.push(organization.slug)
    }
    if (shared.length > 0) return { ok: false, reason: "shared", organizations: shared }

    const projects: PreparedProjectTeardown[] = []
    for (const organization of organizations) {
      const prepared = await prepareOne(tx, {
        organizationId: organization.id,
        soleMemberUserId: userId,
      })
      if (!prepared.ok) throw new Error(`Organization ${organization.id} changed during deletion`)
      projects.push(...prepared.projects)
    }
    return { ok: true, projects }
  })
}

async function prepareOne(
  tx: Transaction<DB>,
  input: { organizationId: string; soleMemberUserId?: string },
): Promise<PrepareOrganizationTeardownResult> {
  const organization = await tx
    .selectFrom("organization")
    .select(["id", "ownerUserId"])
    .where("id", "=", input.organizationId)
    .where("deletedAt", "is", null)
    .forUpdate()
    .executeTakeFirst()
  if (organization === undefined) return { ok: false, reason: "not_found" }

  if (input.soleMemberUserId !== undefined) {
    const membership = await tx
      .selectFrom("organizationMember")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organizationId", "=", organization.id)
      .where("status", "=", "active")
      .where("userId", "!=", input.soleMemberUserId)
      .executeTakeFirstOrThrow()
    const otherMembers = Number(membership.count)
    if (organization.ownerUserId !== input.soleMemberUserId || otherMembers > 0) {
      return { ok: false, reason: "shared", memberCount: otherMembers + 1 }
    }
  }

  const projects = await tx
    .selectFrom("project")
    .select(["id", "repositoryId"])
    .where("organizationId", "=", organization.id)
    .where("isGroup", "=", false)
    .where("state", "!=", "deleted")
    .execute()
  const now = new Date()

  await tx
    .updateTable("project")
    .set({ deletedAt: now, state: "deleting", updatedAt: now })
    .where("organizationId", "=", organization.id)
    .where("state", "!=", "deleted")
    .execute()
  await tx
    .updateTable("repository")
    .set({ deletedAt: now, updatedAt: now })
    .where("organizationId", "=", organization.id)
    .where("deletedAt", "is", null)
    .execute()
  await tx
    .updateTable("organization")
    .set({ deletedAt: now, updatedAt: now })
    .where("id", "=", organization.id)
    .execute()

  const teardowns: PreparedProjectTeardown[] = []
  for (const project of projects) {
    const job = await crudProjectJob(tx).create({
      organizationId: organization.id,
      projectId: project.id,
      repositoryId: project.repositoryId,
      kind: "delete",
      state: "queued",
      steps: JSON.stringify(initialSteps("delete")),
    })
    teardowns.push({ projectId: project.id, projectJobId: job.id })
  }

  return { ok: true, projects: teardowns }
}
