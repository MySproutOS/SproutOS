import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
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
  return db.transaction().execute((tx) => prepareOrganizationTeardownInTransaction(tx, input))
}

export function prepareOrganizationTeardownInTransaction(
  tx: Transaction<DB>,
  input: { organizationId: string; soleMemberUserId?: string },
): Promise<PrepareOrganizationTeardownResult> {
  return prepareOne(tx, input)
}

/** Prepare every solely-owned organization together, or leave all of them untouched. */
export async function prepareAccountOrganizationsForTeardown(
  db: Kysely<DB>,
  userId: string,
): Promise<PrepareAccountOrganizationsResult> {
  return db
    .transaction()
    .execute((tx) => prepareAccountOrganizationsForTeardownInTransaction(tx, userId))
}

export async function prepareAccountOrganizationsForTeardownInTransaction(
  tx: Transaction<DB>,
  userId: string,
): Promise<PrepareAccountOrganizationsResult> {
  const organizations = await tx
    .selectFrom("organization")
    .select(["id", "slug", "deletedAt"])
    .where("ownerUserId", "=", userId)
    .orderBy("id")
    .forUpdate()
    .execute()

  const shared: string[] = []
  for (const organization of organizations) {
    if (organization.deletedAt !== null) continue
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
      // An already-deleted organization has no ownership to transfer. Its remaining projects are
      // cleanup debt, and former memberships must not make that debt impossible to adopt.
      ...(organization.deletedAt === null ? { soleMemberUserId: userId } : {}),
      includeDeleted: true,
    })
    if (!prepared.ok) throw new Error(`Organization ${organization.id} changed during deletion`)
    projects.push(...prepared.projects)
  }
  return { ok: true, projects }
}

async function prepareOne(
  tx: Transaction<DB>,
  input: { organizationId: string; soleMemberUserId?: string; includeDeleted?: boolean },
): Promise<PrepareOrganizationTeardownResult> {
  let organizationQuery = tx
    .selectFrom("organization")
    .select(["id", "ownerUserId"])
    .where("id", "=", input.organizationId)
  if (input.includeDeleted !== true) {
    organizationQuery = organizationQuery.where("deletedAt", "is", null)
  }
  const organization = await organizationQuery.forUpdate().executeTakeFirst()
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
  const clock = await sql<{ now: Date }>`select transaction_timestamp() as now`.execute(tx)
  const now = clock.rows[0]?.now
  if (now === undefined) throw new Error("Postgres returned no deletion cutoff")

  await tx
    .updateTable("project")
    .set({ deletedAt: now, state: "deleting", updatedAt: now })
    .where("organizationId", "=", organization.id)
    .where("isGroup", "=", false)
    .where("state", "!=", "deleted")
    .execute()
  // Groups own no provider resource, so there is no worker step that could advance them later.
  await tx
    .updateTable("project")
    .set({ deletedAt: now, state: "deleted", updatedAt: now })
    .where("organizationId", "=", organization.id)
    .where("isGroup", "=", true)
    .where("state", "!=", "deleted")
    .execute()
  await tx
    .updateTable("repository")
    .set({ deletedAt: now, updatedAt: now })
    .where("organizationId", "=", organization.id)
    .where("deletedAt", "is", null)
    .execute()
  // Stop the platform minting any new installation tokens. This disconnects SproutOS from the
  // source account; it deliberately does not call GitHub's repository deletion API.
  await tx
    .updateTable("githubInstallation")
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
      deletionReason: "user_requested",
      serviceCutoffAt: now,
      steps: JSON.stringify(initialSteps("delete")),
    })
    teardowns.push({ projectId: project.id, projectJobId: job.id })
  }

  return { ok: true, projects: teardowns }
}
