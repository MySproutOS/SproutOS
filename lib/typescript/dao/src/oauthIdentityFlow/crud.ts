import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudOauthIdentityFlow(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["oauthIdentityFlow"]>, "id">,
  ): Promise<Selectable<DB["oauthIdentityFlow"]>> {
    return await db
      .insertInto("oauthIdentityFlow")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function consume(
    stateHash: string,
    sessionKey: string,
  ): Promise<Selectable<DB["oauthIdentityFlow"]> | undefined> {
    return await db
      .updateTable("oauthIdentityFlow")
      .set({ consumedAt: new Date() })
      .where("stateHash", "=", stateHash)
      .where("sessionKey", "=", sessionKey)
      .where("consumedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .returningAll()
      .executeTakeFirst()
  }

  return { consume, create }
}
