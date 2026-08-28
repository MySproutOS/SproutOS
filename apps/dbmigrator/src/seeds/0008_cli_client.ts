import {
  SPROUT_CLI_CLIENT_ID,
  SPROUT_CLI_DEFAULT_SCOPES,
  SPROUT_CLI_REDIRECT_URI,
} from "@lib/oauth-provider"
import type { Kysely } from "kysely"
import { asRow } from "../lib/rows"
import { uuidV7 } from "../lib/uuid"

/** The public, first-party OAuth client compiled into the cross-platform `sprout` CLI. */
export async function seed(db: Kysely<any>): Promise<void> {
  const existing = asRow(
    await db
      .selectFrom("oauth_client")
      .select("id")
      .where("id", "=", SPROUT_CLI_CLIENT_ID)
      .executeTakeFirst(),
  )

  if (!existing) {
    await db
      .insertInto("oauth_client")
      .values({
        id: SPROUT_CLI_CLIENT_ID,
        name: "Sprout CLI",
        description: "The official SproutOS command-line client.",
        homepage_url: "https://sproutos.me/download",
        client_type: "public",
        is_first_party: true,
        is_verified: true,
        organization_id: null,
        owner_user_id: null,
        default_scopes: [...SPROUT_CLI_DEFAULT_SCOPES],
      })
      .execute()
  }

  const redirect = asRow(
    await db
      .selectFrom("oauth_client_redirect_uri")
      .select("id")
      .where("oauth_client_id", "=", SPROUT_CLI_CLIENT_ID)
      .where("uri", "=", SPROUT_CLI_REDIRECT_URI)
      .executeTakeFirst(),
  )

  if (!redirect) {
    await db
      .insertInto("oauth_client_redirect_uri")
      .values({
        id: uuidV7(),
        oauth_client_id: SPROUT_CLI_CLIENT_ID,
        uri: SPROUT_CLI_REDIRECT_URI,
      })
      .execute()
  }
}
