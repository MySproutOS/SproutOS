import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function crudSandboxDatabaseBranch(db: Kysely<DB>) {
  async function create(input: {
    sandboxId: string
    databaseBranchId: string
  }): Promise<Selectable<DB["sandboxDatabaseBranch"]>> {
    return await db
      .insertInto("sandboxDatabaseBranch")
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create }
}
