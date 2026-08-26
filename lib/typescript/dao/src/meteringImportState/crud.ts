import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

export function crudMeteringImportState(db: Kysely<DB>) {
  async function setCursor(consumer: string, cursor: Date): Promise<void> {
    await db
      .insertInto("meteringImportState")
      .values({ consumer, cursor })
      .onConflict((oc) => oc.column("consumer").doUpdateSet({ cursor, updatedAt: new Date() }))
      .execute()
  }

  return { setCursor }
}
