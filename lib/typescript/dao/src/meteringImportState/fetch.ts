import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

export function fetchMeteringImportState(db: Kysely<DB>) {
  async function cursor(consumer: string): Promise<Date | undefined> {
    return (
      await db
        .selectFrom("meteringImportState")
        .select("cursor")
        .where("consumer", "=", consumer)
        .executeTakeFirst()
    )?.cursor
  }

  return { cursor }
}
