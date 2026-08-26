import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Reads of `repository` filter `deleted_at IS NULL` (ADR 0017) and take the organization id
 * alongside the resource id.
 *
 * `getInOrganization`, never `getOne`: `requirePermission` authorizes an action against an SRN it
 * builds from the resolved organization plus an unverified path parameter, so a repository id
 * belonging to another organization produces a well-formed SRN in *this* one and passes the
 * check. The tenancy predicate here is what turns that into a 404.
 */
export function fetchRepository(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["repository"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["repository"]>, T[number]> | undefined> {
    return await db
      .selectFrom("repository")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function getByGithubRepoId<T extends (keyof DB["repository"])[]>(
    organizationId: string,
    githubRepoId: string | number | bigint,
    fields: T,
  ): Promise<Pick<Selectable<DB["repository"]>, T[number]> | undefined> {
    return await db
      .selectFrom("repository")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("githubRepoId", "=", String(githubRepoId))
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  function listInOrganizationQuery(organizationId: string) {
    return db
      .selectFrom("repository")
      .where("repository.organizationId", "=", organizationId)
      .where("repository.deletedAt", "is", null)
      .select([
        "repository.id as id",
        "repository.githubRepoId as githubRepoId",
        "repository.ownerLogin as ownerLogin",
        "repository.name as name",
        "repository.defaultBranch as defaultBranch",
        "repository.private as private",
        "repository.isFork as isFork",
        "repository.provenance as provenance",
        "repository.upstreamFullName as upstreamFullName",
        "repository.githubInstallationId as githubInstallationId",
        "repository.createdAt as createdAt",
      ])
      .orderBy("repository.id", "desc")
  }

  /**
   * How many live projects share this repository.
   *
   * TASK 21: two projects may be two directories or two branches of one repository, so a
   * repository is only detachable once the last of them is gone.
   */
  /**
   * How many *deployable* projects this repository has.
   *
   * Groups are excluded. This number answers "is anything else using this repository", which decides
   * whether deleting a project also deletes the repository and how the UI describes what is at
   * stake — and a group is a container, not a use. Counting it means a repository with one app in a
   * group reads as two projects, and deleting that app would look like it leaves something behind.
   *
   * The same exclusion `findConflictingTarget` and `project_repository_target_live_key` already
   * make, for the same reason: a group has no build target.
   */
  async function countLiveProjects(id: string): Promise<number> {
    const row = await db
      .selectFrom("project")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("repositoryId", "=", id)
      .where("deletedAt", "is", null)
      .where("isGroup", "=", false)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return { countLiveProjects, getByGithubRepoId, getInOrganization, listInOrganizationQuery }
}
