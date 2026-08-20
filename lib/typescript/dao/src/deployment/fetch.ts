import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Reads of `deployment` filter `deleted_at IS NULL` (ADR 0017).
 *
 * `deployment` carries no `organization_id` — it hangs off `project` — so every tenancy check here
 * is a join. That is not an inconvenience to work around: `requirePermission` authorizes an action
 * against an SRN built from the *resolved* organization plus an unverified path parameter, so a
 * deployment id belonging to another organization produces a well-formed SRN in this one and passes
 * the permission check. The join is what turns that into a 404.
 */
export function fetchDeployment(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["deployment"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["deployment"]>, T[number]> | undefined> {
    // `exists` rather than a join: a join makes every selected column ambiguous — `id`, `createdAt`
    // and `deletedAt` all exist on both tables — which forces the caller's field names to be
    // rewritten and the result cast back. The predicate expresses the same tenancy rule and leaves
    // the select alone.
    return await db
      .selectFrom("deployment")
      .select(fields)
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("project")
            .select("project.id")
            .whereRef("project.id", "=", "deployment.projectId")
            .where("project.organizationId", "=", organizationId)
            .where("project.deletedAt", "is", null),
        ),
      )
      .executeTakeFirst()
  }

  /**
   * What the deploy job needs to render a Knative Service: the deployment and the project it
   * belongs to, in one read.
   *
   * Together rather than separately because the hostname is derived from both, and a job that
   * fetched them in two round trips could render a host for a project that was renamed in between.
   */
  async function withProject(id: string): Promise<
    | {
        deployment: Selectable<DB["deployment"]>
        project: Pick<Selectable<DB["project"]>, "id" | "slug" | "organizationId">
      }
    | undefined
  > {
    const row = await db
      .selectFrom("deployment")
      .innerJoin("project", "project.id", "deployment.projectId")
      .selectAll("deployment")
      .select([
        "project.id as projectRowId",
        "project.slug as projectSlug",
        "project.organizationId as projectOrganizationId",
      ])
      .where("deployment.id", "=", id)
      .where("deployment.deletedAt", "is", null)
      .where("project.deletedAt", "is", null)
      .executeTakeFirst()

    if (row === undefined) return undefined

    const { projectRowId, projectSlug, projectOrganizationId, ...deployment } = row

    return {
      deployment: deployment,
      project: { id: projectRowId, slug: projectSlug, organizationId: projectOrganizationId },
    }
  }

  /**
   * The live production deployment for a project, if there is one.
   *
   * Ordered by `created_at` rather than trusting a status: two deployments can be `ready` at once
   * during a rollout, and the newer one is the one serving.
   */
  async function currentProduction<T extends (keyof DB["deployment"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["deployment"]>, T[number]> | undefined> {
    return await db
      .selectFrom("deployment")
      .select(fields)
      .where("projectId", "=", projectId)
      .where("kind", "=", "production")
      .where("status", "=", "ready")
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "desc")
      .executeTakeFirst()
  }

  return { currentProduction, getInOrganization, withProject }
}
