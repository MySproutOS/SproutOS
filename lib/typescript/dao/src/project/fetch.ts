import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Reads of `project` filter `deleted_at IS NULL` (ADR 0017) and are scoped by organization.
 *
 * There is no `getOne(id)` on purpose. `requirePermission` builds its SRN from the resolved
 * organization and a path parameter it does not verify, so an id from another tenant authorizes
 * cleanly; the only thing standing between that and a cross-tenant read is this predicate.
 */
export function fetchProject(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["project"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["project"]>, T[number]> | undefined> {
    return await db
      .selectFrom("project")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function getBySlug<T extends (keyof DB["project"])[]>(
    organizationId: string,
    slug: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["project"]>, T[number]> | undefined> {
    return await db
      .selectFrom("project")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("slug", "=", slug)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  function listInOrganizationQuery(organizationId: string, repositoryId: string | null = null) {
    return db
      .selectFrom("project")
      .innerJoin("repository", "repository.id", "project.repositoryId")
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .$if(repositoryId !== null, (qb) => qb.where("project.repositoryId", "=", repositoryId!))
      .select([
        "project.id as id",
        "project.name as name",
        "project.slug as slug",
        "project.kind as kind",
        "project.state as state",
        "project.stateReason as stateReason",
        "project.rootDir as rootDir",
        "project.productionBranch as productionBranch",
        "project.autoUpdateEnabled as autoUpdateEnabled",
        "project.autoUpdateMode as autoUpdateMode",
        "project.repositoryId as repositoryId",
        "project.storeListingId as storeListingId",
        "project.agentCredentialId as agentCredentialId",
        "project.createdAt as createdAt",
        "project.updatedAt as updatedAt",
        "repository.ownerLogin as repositoryOwnerLogin",
        "repository.name as repositoryName",
        "repository.provenance as repositoryProvenance",
      ])
      .orderBy("project.id", "desc")
  }

  /**
   * Whether another live project already occupies this repository at this directory and branch.
   *
   * The partial unique index `(organization_id, repository_id, root_dir, production_branch)` is
   * the authority; this exists so the API can answer 409 with a sentence instead of letting a
   * constraint violation surface as a 500.
   */
  async function findConflictingTarget(input: {
    organizationId: string
    repositoryId: string
    rootDir: string
    productionBranch: string
  }): Promise<{ id: string; slug: string } | undefined> {
    return await db
      .selectFrom("project")
      .select(["id", "slug"])
      .where("organizationId", "=", input.organizationId)
      .where("repositoryId", "=", input.repositoryId)
      .where("rootDir", "=", input.rootDir)
      .where("productionBranch", "=", input.productionBranch)
      .where("deletedAt", "is", null)
      /*
        Groups are not build targets, so they cannot conflict with one.

        This mirrors `project_repository_target_live_key`, which excludes them for the same reason:
        a group's `root_dir` is `.` by definition, so without this the first group on a repository
        blocks every later group *and* any project that builds from the repository root. Two places
        express one rule, and they have to agree — the index is what makes it true under a race, and
        this is what makes the error a sentence rather than a constraint violation.
      */
      .where("isGroup", "=", false)
      .executeTakeFirst()
  }

  return { findConflictingTarget, getBySlug, getInOrganization, listInOrganizationQuery }
}
