import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Selectable } from "kysely"

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
      .innerJoin("deployment", "deployment.id", "androidApp.latestGoodDeploymentId")
      // Template provenance is intentionally not publication. Every customer fork retains
      // project.storeListingId; only the listing's explicit canonical release is anonymous.
      .innerJoin("storeListing", "storeListing.canonicalAndroidAppId", "androidApp.id")
      .leftJoin("storeCategory", "storeCategory.id", "storeListing.categoryId")
      .innerJoin("androidSignerJob", (join) =>
        join
          .onRef("androidSignerJob.deploymentId", "=", "androidApp.latestGoodDeploymentId")
          .on("androidSignerJob.state", "=", "succeeded"),
      )
      .select(catalogueFields)
      .select([
        "storeListing.name as label",
        "storeListing.descriptionMd as summary",
        "storeCategory.name as category",
      ])
      .where("storeListing.platform", "=", "android")
      .where("storeListing.status", "=", "published")
      .where("storeListing.deletedAt", "is", null)
      .where("project.deletedAt", "is", null)
      .where("androidApp.developerConsoleState", "=", "registered")
      .where("androidApp.developerConsoleProviderState", "=", "REGISTERED")
      .where("androidApp.verifiedSetupCommit", "is not", null)
      .where("deployment.status", "=", "ready")
      .execute()
  }

  /**
   * Verifies that an exact signed release is eligible to become a listing's anonymous release.
   * The project/listing relationship is provenance only; the caller must separately write the
   * listing's explicit canonical association after this check succeeds.
   */
  async function getPublishableForListing(listingId: string, androidAppId: string) {
    return await db
      .selectFrom("androidApp")
      .innerJoin("project", "project.id", "androidApp.projectId")
      .innerJoin("deployment", "deployment.id", "androidApp.latestGoodDeploymentId")
      .innerJoin("androidSignerJob", (join) =>
        join
          .onRef("androidSignerJob.deploymentId", "=", "androidApp.latestGoodDeploymentId")
          .on("androidSignerJob.state", "=", "succeeded"),
      )
      .select(["androidApp.id", "project.id as projectId", "deployment.id as deploymentId"])
      .where("androidApp.id", "=", androidAppId)
      .where("project.storeListingId", "=", listingId)
      .where("project.deletedAt", "is", null)
      .where("androidApp.developerConsoleState", "=", "registered")
      .where("androidApp.developerConsoleProviderState", "=", "REGISTERED")
      .where("androidApp.verifiedSetupCommit", "is not", null)
      .where("deployment.status", "=", "ready")
      .executeTakeFirst()
  }

  async function listPersonalCatalogue(userId: string, organizationId: string | null = null) {
    return await db
      .selectFrom("androidApp")
      .innerJoin("project", "project.id", "androidApp.projectId")
      .innerJoin("deployment", "deployment.id", "androidApp.latestGoodDeploymentId")
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
      .select((eb) => eb.val(null).$castTo<string | null>().as("category"))
      .where("organizationMember.userId", "=", userId)
      .$if(organizationId !== null, (qb) =>
        qb.where("project.organizationId", "=", organizationId!),
      )
      .where("project.deletedAt", "is", null)
      .where("androidApp.developerConsoleState", "=", "registered")
      .where("androidApp.developerConsoleProviderState", "=", "REGISTERED")
      .where("androidApp.verifiedSetupCommit", "is not", null)
      .where("deployment.status", "=", "ready")
      .execute()
  }

  async function registrationQueueHealth(now: Date, androidAppIds?: string[]) {
    const queue = await db
      .selectFrom("androidApp")
      .select([
        sql<string>`count(*) filter (
          where certificate_sha256 is not null and developer_console_state <> 'registered'
        )`.as("pendingCount"),
        sql<string>`count(*) filter (
          where certificate_sha256 is not null
            and developer_console_state <> 'registered'
            and developer_console_next_check_at <= ${now}
        )`.as("dueCount"),
        sql<string>`count(*) filter (
          where certificate_sha256 is not null
            and developer_console_state = 'registered'
            and developer_console_next_check_at <= ${now}
        )`.as("revalidationDueCount"),
        sql<string>`count(*) filter (
          where certificate_sha256 is not null and developer_console_last_failure is not null
        )`.as("failureCount"),
        sql<Date | null>`min(created_at) filter (
          where certificate_sha256 is not null and developer_console_state <> 'registered'
        )`.as("oldestPendingAt"),
        sql<Date | null>`min(developer_console_last_checked_at) filter (
          where certificate_sha256 is not null and developer_console_last_failure is not null
        )`.as("oldestFailureAt"),
      ])
      .where((eb) =>
        androidAppIds === undefined ? eb.val(true) : eb("androidApp.id", "in", androidAppIds),
      )
      .executeTakeFirstOrThrow()
    const worker = await db
      .selectFrom("androidRegistrationReconcilerState")
      .select([
        "lastSeenAt",
        "lastCompletedAt",
        "lastFailure",
        "quotaProviderDate",
        "quotaReserved",
        "terminalBlockedAt",
        "terminalFailureKind",
      ])
      .where("id", "=", "developer-id-status")
      .executeTakeFirstOrThrow()
    return { ...queue, ...worker }
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
      // A project can retain several successful production deployment rows for history. Personal
      // is a current launcher, so expose only the deployment that is actually live; otherwise the
      // same URL appears repeatedly and older URLs remain discoverable after a cutover.
      .whereRef("deployment.id", "=", "project.liveDeploymentId")
      .where("deployment.kind", "=", "production")
      .where("deployment.status", "=", "ready")
      .where("deployment.url", "is not", null)
      .where("project.deletedAt", "is", null)
      .where("deployment.deletedAt", "is", null)
      .execute()
  }

  return {
    getForProject,
    getOne,
    getPublishableForListing,
    listPersonalCatalogue,
    listPersonalSites,
    listPublicCatalogue,
    registrationQueueHealth,
  }
}
