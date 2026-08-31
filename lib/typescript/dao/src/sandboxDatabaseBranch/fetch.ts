import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchSandboxDatabaseBranch(db: Kysely<DB>) {
  async function listForSandbox(
    sandboxId: string,
  ): Promise<Selectable<DB["sandboxDatabaseBranch"]>[]> {
    return await db
      .selectFrom("sandboxDatabaseBranch")
      .selectAll()
      .where("sandboxId", "=", sandboxId)
      .orderBy("createdAt", "asc")
      .execute()
  }

  async function getAdditional(
    sandboxId: string,
    databaseBranchId: string,
  ): Promise<Selectable<DB["sandboxDatabaseBranch"]> | undefined> {
    return await db
      .selectFrom("sandboxDatabaseBranch")
      .innerJoin("sandbox", "sandbox.id", "sandboxDatabaseBranch.sandboxId")
      .innerJoin("databaseBranch", "databaseBranch.id", "sandboxDatabaseBranch.databaseBranchId")
      .selectAll("sandboxDatabaseBranch")
      .where("sandboxDatabaseBranch.sandboxId", "=", sandboxId)
      .where("sandboxDatabaseBranch.databaseBranchId", "=", databaseBranchId)
      .where("databaseBranch.deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("sandbox.databaseBranchId", "is", null),
          eb("sandbox.databaseBranchId", "!=", databaseBranchId),
        ]),
      )
      .executeTakeFirst()
  }

  return { getAdditional, listForSandbox }
}
