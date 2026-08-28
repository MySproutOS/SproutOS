import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

const PLATFORM_CERTIFICATE_ID = "platform"

export function fetchPlatformEdgeCertificate(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["platformEdgeCertificate"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["platformEdgeCertificate"]>, T[number]> | undefined> {
    return await db
      .selectFrom("platformEdgeCertificate")
      .select(fields)
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .executeTakeFirst()
  }

  return { getOne }
}
