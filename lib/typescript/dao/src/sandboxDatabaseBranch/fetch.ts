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
      .selectAll("sandboxDatabaseBranch")
      .where("sandboxDatabaseBranch.sandboxId", "=", sandboxId)
      .where("sandboxDatabaseBranch.databaseBranchId", "=", databaseBranchId)
      .whereRef("sandboxDatabaseBranch.databaseBranchId", "!=", "sandbox.databaseBranchId")
      .executeTakeFirst()
  }

  return { getAdditional, listForSandbox }
}
