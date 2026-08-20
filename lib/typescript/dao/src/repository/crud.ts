import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

/**
 * The `github_repo_id` a repository holds before GitHub has actually created it.
 *
 * `project.repository_id` is `NOT NULL`, so the project row cannot exist until a repository row
 * does — and provisioning is asynchronous, so the real numeric id does not exist yet. The column
 * is `NOT NULL bigint` under a partial unique index on `(organization_id, github_repo_id)`, which
 * rules out a shared sentinel: two projects created in one organization before either finished
 * would collide.
 *
 * GitHub's ids are always positive, so the negative half of the range is free. Deriving the
 * placeholder from the low bits of the repository's own UUIDv7 keeps it unique per row without a
 * second round trip, and makes "has this been created upstream yet" a sign test.
 */
export function pendingGithubRepoId(repositoryId: string): string {
  const random = repositoryId.replaceAll("-", "").slice(-15)
  return (-BigInt(`0x${random}`)).toString()
}

/** Whether a repository row is still waiting on GitHub. */
export function isPendingGithubRepoId(githubRepoId: string | number | bigint): boolean {
  return BigInt(githubRepoId) < 0n
}

export function crudRepository(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["repository"]>, "id">,
  ): Promise<Selectable<DB["repository"]>> {
    return await db
      .insertInto("repository")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Creates the placeholder row a project can point at while its GitHub repository is still being
   * created. The provisioning job overwrites `githubRepoId`, `ownerLogin`, and `name` when the
   * upstream call returns.
   */
  async function createPending(
    data: Omit<PartialBy<Insertable<DB["repository"]>, "id">, "githubRepoId">,
  ): Promise<Selectable<DB["repository"]>> {
    const id = data.id ?? v7()

    return await db
      .insertInto("repository")
      .values({ ...data, id, githubRepoId: pendingGithubRepoId(id) })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["repository"]>,
  ): Promise<Selectable<DB["repository"]> | undefined> {
    return await db
      .updateTable("repository")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Soft-deletes a repository, per ADR 0017.
   *
   * `project.repository_id` is `ON DELETE RESTRICT` and projects are themselves referenced by
   * `usage_event`, so a hard delete here is either blocked or destroys billing history depending
   * on which row goes first.
   */
  async function softDelete(id: string): Promise<boolean> {
    const result = await db
      .updateTable("repository")
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  return { create, createPending, softDelete, update }
}
