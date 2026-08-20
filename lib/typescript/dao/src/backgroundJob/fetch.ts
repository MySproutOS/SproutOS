import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchBackgroundJob(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["backgroundJob"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["backgroundJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("backgroundJob")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function getByIdempotencyKey<T extends (keyof DB["backgroundJob"])[]>(
    idempotencyKey: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["backgroundJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("backgroundJob")
      .select(fields)
      .where("idempotencyKey", "=", idempotencyKey)
      .executeTakeFirst()
  }

  async function countByKind(kind: string): Promise<number> {
    const row = await db
      .selectFrom("backgroundJob")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("kind", "=", kind)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  return { getOne, getByIdempotencyKey, countByKind }
}
