import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudProject(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["project"]>, "id">,
  ): Promise<Selectable<DB["project"]>> {
    return await db
      .insertInto("project")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    organizationId: string,
    id: string,
    data: Updateable<DB["project"]>,
  ): Promise<Selectable<DB["project"]> | undefined> {
    return await db
      .updateTable("project")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Set one direct deployable child as a group's primary project in one conditional statement.
   *
   * The API reads both rows to produce useful validation errors, but this predicate is the race
   * authority: moving or deleting the child between that read and this write must not leave a group
   * pointing at something it no longer contains.
   */
  async function setPrimaryChild(
    organizationId: string,
    groupProjectId: string,
    childProjectId: string,
  ): Promise<Selectable<DB["project"]> | undefined> {
    return await db
      .updateTable("project")
      .set({ primaryChildProjectId: childProjectId, updatedAt: new Date() })
      .where("id", "=", groupProjectId)
      .where("organizationId", "=", organizationId)
      .where("isGroup", "=", true)
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("project as child")
            .select("child.id")
            .where("child.id", "=", childProjectId)
            .where("child.organizationId", "=", organizationId)
            .where("child.parentProjectId", "=", groupProjectId)
            .where("child.isGroup", "=", false)
            .where("child.deletedAt", "is", null),
        ),
      )
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Soft-deletes a project, per ADR 0017.
   *
   * `usage_event.project_id` is `ON DELETE RESTRICT`: a hard delete either fails or, if the
   * ledger rows went first, destroys the billing history that justifies charges already made. The
   * row moves to `deleting` and a `project_job` tears down the external resources.
   *
   * Conditional on `deleted_at IS NULL`, so a double delete produces one state change and the
   * second caller learns the project was already gone.
   */
  async function softDelete(
    organizationId: string,
    id: string,
  ): Promise<Selectable<DB["project"]> | undefined> {
    const now = new Date()

    return await db
      .updateTable("project")
      .set({ deletedAt: now, updatedAt: now, state: "deleting" })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Turns auto-update off for every project on repositories bound to one installation.
   *
   * ADR 0007 requires this on `installation.deleted`: without it, upkeep keeps being scheduled
   * against an installation whose token can no longer be minted, and it fails silently at 3 a.m.
   */
  async function disableAutoUpdateForInstallation(githubInstallationId: string): Promise<number> {
    const result = await db
      .updateTable("project")
      .set({ autoUpdateEnabled: false, updatedAt: new Date() })
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb(
          "repositoryId",
          "in",
          eb
            .selectFrom("repository")
            .select("repository.id")
            .where("repository.githubInstallationId", "=", githubInstallationId),
        ),
      )
      .executeTakeFirst()

    return Number(result.numUpdatedRows)
  }

  return { create, disableAutoUpdateForInstallation, setPrimaryChild, softDelete, update }
}
