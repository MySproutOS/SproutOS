import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchDatabaseBranch(db: Kysely<DB>) {
  async function listForService(organizationId: string, backendServiceId: string) {
    return await db
      .selectFrom("databaseBranch")
      .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
      .select([
        "databaseBranch.id",
        "databaseBranch.name",
        "databaseBranch.kind",
        "databaseBranch.parentBranchId",
        "databaseBranch.isProtected",
        "databaseBranch.provisioningState",
        "databaseBranch.createdAt",
        "databaseBranch.expiresAt",
        "databaseBranch.createdByUserId",
      ])
      .where("databaseInstance.backendServiceId", "=", backendServiceId)
      .where("databaseInstance.deletedAt", "is", null)
      .where("databaseBranch.deletedAt", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("backendService")
            .select("backendService.id")
            .whereRef("backendService.id", "=", "databaseInstance.backendServiceId")
            .where("backendService.organizationId", "=", organizationId)
            .where("backendService.deletedAt", "is", null),
        ),
      )
      .orderBy("databaseBranch.createdAt", "asc")
      .execute()
  }

  async function getInService(
    organizationId: string,
    backendServiceId: string,
    databaseBranchId: string,
  ) {
    return await db
      .selectFrom("databaseBranch")
      .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
      .innerJoin("backendService", "backendService.id", "databaseInstance.backendServiceId")
      .select([
        "databaseBranch.id",
        "databaseBranch.kind",
        "databaseBranch.isProtected",
        "databaseBranch.provisioningState",
      ])
      .where("backendService.organizationId", "=", organizationId)
      .where("backendService.id", "=", backendServiceId)
      .where("backendService.deletedAt", "is", null)
      .where("databaseBranch.id", "=", databaseBranchId)
      .where("databaseBranch.deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function getOne<T extends (keyof DB["databaseBranch"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["databaseBranch"]>, T[number]> | undefined> {
    return await db
      .selectFrom("databaseBranch")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function expiredUnprotected(now: Date, limit: number): Promise<{ id: string }[]> {
    return await db
      .selectFrom("databaseBranch")
      .select("id")
      .where("expiresAt", "is not", null)
      .where("expiresAt", "<=", now)
      .where("isProtected", "=", false)
      .where((eb) => eb.or([eb("cleanupRetryAt", "is", null), eb("cleanupRetryAt", "<=", now)]))
      .orderBy("expiresAt", "asc")
      .limit(limit)
      .execute()
  }

  return { expiredUnprotected, getInService, getOne, listForService }
}
