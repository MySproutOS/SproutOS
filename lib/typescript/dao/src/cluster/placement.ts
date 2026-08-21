import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Which cluster a project's workloads run on.
 *
 * The control plane is on AWS; a customer's own backends and workflows can be elsewhere.
 * `project.region_id` records the choice, `region.provider` says which cloud that region belongs to,
 * and this turns the pair into the cluster a deployment actually lands on.
 */
export type Placement = {
  clusterId: string
  /** Where images for this cluster are pulled from. Null when the cluster has no registry recorded. */
  registry: string | null
  provider: string
  regionCode: string
}

export function fetchPlacement(db: Kysely<DB>) {
  /**
   * The cluster for a project, or `undefined` when there is nowhere to put it.
   *
   * `undefined` rather than falling back to any active cluster. A customer who asked for `eu-west-1`
   * and silently got `us-east-1` has had a data-residency promise broken by a default, and a
   * deployment that refuses to start is enormously preferable to one that starts in the wrong
   * country.
   *
   * A project with no region takes any active production cluster, which is the honest reading of
   * "wherever the platform puts you".
   */
  async function forProject(projectId: string): Promise<Placement | undefined> {
    const project = await db
      .selectFrom("project")
      .select("regionId")
      .where("id", "=", projectId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (project === undefined) return undefined

    let query = db
      .selectFrom("cluster")
      .innerJoin("region", "region.id", "cluster.regionId")
      .select([
        "cluster.id as clusterId",
        "cluster.registry as registry",
        "region.provider as provider",
        "region.code as regionCode",
      ])
      .where("cluster.status", "=", "active")
      .where("cluster.environment", "=", "prod")
      .where("region.isActive", "=", true)
      // Stable rather than arbitrary: two deployments of the same project should land in the same
      // place, and `order by random()` would scatter one customer's workloads across clusters for
      // no reason anybody could later explain.
      .orderBy("cluster.name", "asc")

    if (project.regionId !== null) {
      query = query.where("cluster.regionId", "=", project.regionId)
    }

    return await query.executeTakeFirst()
  }

  async function byId(clusterId: string): Promise<Selectable<DB["cluster"]> | undefined> {
    return await db.selectFrom("cluster").selectAll().where("id", "=", clusterId).executeTakeFirst()
  }

  return { byId, forProject }
}
