import type { Kysely } from "kysely"
import { asRow, text } from "../lib/rows"
import { uuidV7 } from "../lib/uuid"

/**
 * The SproutOS Android client, as an OAuth client.
 *
 * Seeded rather than registered through the API, because it is not a customer's application: it is
 * the platform signing people into itself, and there is nobody whose account should be able to
 * revoke it.
 *
 * **Public, so there is no secret.** Anything compiled into an APK is readable by anyone who
 * downloads it, so a secret here would be a secret that is not one — which is exactly why the flow
 * is PKCE and why `oauth_client_secret` gets no row.
 */
/*
  A fixed UUID, not the readable string "sproutos-android".

  `oauth_client.id` is a `uuid` column and the client id *is* that primary key — there is no
  separate readable identifier. So the app compiles this in, and the one thing that matters is that
  it never changes: a new id is a client nothing has granted, and every signed-in customer would be
  asked to authorise again.
*/
const CLIENT_ID = "01a03b00-0000-7000-8000-0000000a4d01"

/**
 * The redirect the app registers in its manifest.
 *
 * A custom scheme, which any app on the device can also claim. That is a property of Android, not
 * a weakness here — the `state` check in the client and the PKCE verifier are what make an
 * intercepted redirect useless, and neither depends on the scheme being exclusive.
 */
const REDIRECT_URI = "sproutos://auth/callback"

export async function seed(db: Kysely<any>): Promise<void> {
  const existing = asRow(
    await db
      .selectFrom("oauth_client")
      .select(["id"])
      .where("id", "=", CLIENT_ID)
      .executeTakeFirst(),
  )

  if (!existing) {
    await db
      .insertInto("oauth_client")
      .values({
        id: CLIENT_ID,
        name: "SproutOS for Android",
        description: "The SproutOS app catalogue client.",
        homepage_url: "https://sproutos.me/download",
        client_type: "public",
        is_first_party: true,
        is_verified: true,
        organization_id: null,
        owner_user_id: null,
      })
      .execute()
  }

  const registered = asRow(
    await db
      .selectFrom("oauth_client_redirect_uri")
      .select(["id"])
      .where("oauth_client_id", "=", CLIENT_ID)
      .where("uri", "=", REDIRECT_URI)
      .executeTakeFirst(),
  )

  // Idempotent, like every other seed here: re-running must not accumulate duplicate redirects,
  // because the authorize endpoint matches exactly and a duplicate is only noise in an audit.
  if (!registered) {
    await db
      .insertInto("oauth_client_redirect_uri")
      .values({ id: uuidV7(), oauth_client_id: CLIENT_ID, uri: REDIRECT_URI })
      .execute()
  }

  void text
}
