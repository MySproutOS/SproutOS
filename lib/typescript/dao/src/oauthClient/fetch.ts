import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * `oauth_client.client_type`, and it decides whether a secret exists at all.
 *
 * A **confidential** client can keep one — it runs on a server the developer controls. A **public**
 * client cannot: a single-page app or a mobile binary ships its code to the person using it, so any
 * secret in it is a secret every user has. Public clients authenticate with PKCE instead, which is
 * why `oauth.ts` requires a `code_challenge` from them and refuses `plain`.
 */
export type OauthClientType = "confidential" | "public"

/** Fields safe to return to the client's owner. Never includes a secret — see `crud.ts`. */
export const OAUTH_CLIENT_FIELDS = [
  "id",
  "ownerUserId",
  "organizationId",
  "name",
  "description",
  "logoUrl",
  "homepageUrl",
  "clientType",
  "isFirstParty",
  "isVerified",
  "status",
  "defaultScopes",
  "createdAt",
  "updatedAt",
] as const

export function fetchOauthClient(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["oauthClient"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["oauthClient"]>, T[number]> | undefined> {
    return await db.selectFrom("oauthClient").select(fields).where("id", "=", id).executeTakeFirst()
  }

  /**
   * Scoped to the organization, which is the authorization check and not a filter.
   *
   * Every route that touches a client reads it through this. A `getOne` that took only an id would
   * let one organization's member manage another's client the moment a route forgot a `where`.
   */
  async function getInOrganization<T extends (keyof DB["oauthClient"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["oauthClient"]>, T[number]> | undefined> {
    return await db
      .selectFrom("oauthClient")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function listForOrganization<T extends (keyof DB["oauthClient"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["oauthClient"]>, T[number]>[]> {
    return await db
      .selectFrom("oauthClient")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .execute()
  }

  async function listRedirectUris(oauthClientId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("oauthClientRedirectUri")
      .select(["uri"])
      .where("oauthClientId", "=", oauthClientId)
      .orderBy("uri")
      .execute()
    return rows.map((row) => row.uri)
  }

  /**
   * The secrets a client has, without the secrets.
   *
   * `lastFour` and the timestamps are enough to tell two apart in a list and to see which is stale.
   * The hash is deliberately not selectable here: nothing outside the token endpoint has a reason
   * to read it, and a field that is never returned cannot be returned by accident.
   */
  async function listSecrets(oauthClientId: string) {
    return await db
      .selectFrom("oauthClientSecret")
      .select(["id", "lastFour", "createdAt", "expiresAt", "revokedAt", "lastUsedAt"])
      .where("oauthClientId", "=", oauthClientId)
      .orderBy("createdAt", "desc")
      .execute()
  }

  return { getOne, getInOrganization, listForOrganization, listRedirectUris, listSecrets }
}
