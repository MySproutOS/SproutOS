import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchAgentProxyToken(db: Kysely<DB>) {
  /**
   * The row a refresh token belongs to, if it is still usable.
   *
   * Expiry and revocation are checked in the query rather than by the caller. A `getByRefreshHash`
   * that returned expired rows and trusted every caller to test two timestamps is one forgotten
   * check away from a token that never stops working.
   */
  async function liveByRefreshHash(
    hash: string,
  ): Promise<Selectable<DB["agentProxyToken"]> | undefined> {
    return await db
      .selectFrom("agentProxyToken")
      .selectAll()
      .where("refreshTokenHash", "=", hash)
      .where("revokedAt", "is", null)
      .where("refreshExpiresAt", ">", new Date())
      .executeTakeFirst()
  }

  return { liveByRefreshHash }
}
