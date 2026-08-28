import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchAndroidApp(db: Kysely<DB>) {
  const catalogueFields = [
    "androidApp.id as androidAppId",
    "project.id as projectId",
    "androidApp.packageName as packageName",
    "project.name as projectName",
    "androidApp.certificateSha256 as certificateSha256",
    "androidSignerJob.signedKey as signedKey",
    "androidSignerJob.signedObjectVersion as signedObjectVersion",
    "androidSignerJob.signedDigest as sha256",
    "androidSignerJob.signedSizeBytes as sizeBytes",
    "androidSignerJob.versionCode as versionCode",
    "androidSignerJob.versionName as versionName",
  ] as const

  async function getOne<T extends (keyof DB["androidApp"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidApp"]>, T[number]> | undefined> {
    return await db.selectFrom("androidApp").select(fields).where("id", "=", id).executeTakeFirst()
  }

  async function getForProject<T extends (keyof DB["androidApp"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidApp"]>, T[number]> | undefined> {
    return await db
      .selectFrom("androidApp")
      .select(fields)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  async function listPublicCatalogue() {
    return await db
      .selectFrom("androidApp")
      .innerJoin("project", "project.id", "androidApp.projectId")
      .innerJoin("storeListing", "storeListing.id", "project.storeListingId")
      .innerJoin("androidSignerJob", (join) =>
        join
          .onRef("androidSignerJob.deploymentId", "=", "androidApp.latestGoodDeploymentId")
          .on("androidSignerJob.state", "=", "succeeded"),
      )
      .select(catalogueFields)
      .select(["storeListing.name as label", "storeListing.descriptionMd as summary"])
      .where("storeListing.platform", "=", "android")
      .where("storeListing.status", "=", "published")
      .where("storeListing.deletedAt", "is", null)
      .where("project.deletedAt", "is", null)
      .execute()
  }

  async function listPersonalCatalogue(userId: string, organizationId: string | null = null) {
    return await db
      .selectFrom("androidApp")
      .innerJoin("project", "project.id", "androidApp.projectId")
      .innerJoin(
        "organizationMember",
        "organizationMember.organizationId",
        "project.organizationId",
      )
      .innerJoin("androidSignerJob", (join) =>
        join
          .onRef("androidSignerJob.deploymentId", "=", "androidApp.latestGoodDeploymentId")
          .on("androidSignerJob.state", "=", "succeeded"),
      )
      .select(catalogueFields)
      .select(["project.name as label"])
      .select((eb) => eb.val(null).$castTo<string | null>().as("summary"))
      .where("organizationMember.userId", "=", userId)
      .$if(organizationId !== null, (qb) =>
        qb.where("project.organizationId", "=", organizationId!),
      )
      .where("project.deletedAt", "is", null)
      .execute()
  }

  async function listPersonalSites(userId: string, organizationId: string | null = null) {
    return await db
      .selectFrom("deployment")
      .innerJoin("project", "project.id", "deployment.projectId")
      .innerJoin(
        "organizationMember",
        "organizationMember.organizationId",
        "project.organizationId",
      )
      .select(["project.name as name", "deployment.url as url"])
      .where("organizationMember.userId", "=", userId)
      .$if(organizationId !== null, (qb) =>
        qb.where("project.organizationId", "=", organizationId!),
      )
      .where("deployment.kind", "=", "production")
      .where("deployment.status", "=", "ready")
      .where("deployment.url", "is not", null)
      .where("project.deletedAt", "is", null)
      .where("deployment.deletedAt", "is", null)
      .execute()
  }

  return { getForProject, getOne, listPersonalCatalogue, listPersonalSites, listPublicCatalogue }
}
