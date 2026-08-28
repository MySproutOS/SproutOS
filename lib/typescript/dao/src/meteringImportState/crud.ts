import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"

export function crudMeteringImportState(db: Kysely<DB>) {
  async function setCursor(consumer: string, cursor: Date): Promise<void> {
    await db
      .insertInto("meteringImportState")
      .values({ consumer, cursor })
      .onConflict((oc) => oc.column("consumer").doUpdateSet({ cursor, updatedAt: new Date() }))
      .execute()
  }

  /** Advance a shared consumer monotonically when overlapping workers finish out of order. */
  async function advanceCursor(consumer: string, cursor: Date): Promise<void> {
    await db
      .insertInto("meteringImportState")
      .values({ consumer, cursor })
      .onConflict((oc) =>
        oc.column("consumer").doUpdateSet({
          cursor: sql<Date>`greatest(metering_import_state.cursor, excluded.cursor)`,
          updatedAt: new Date(),
        }),
      )
      .execute()
  }

  return { advanceCursor, setCursor }
}
