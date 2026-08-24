import { type Kysely, sql } from "kysely"

/**
 * A first-party OAuth client has no customer to belong to.
 *
 * `oauth_client` was written for the case a customer registers an application: they own it, it
 * belongs to their organization, and both columns are `not null`. SproutOS's own Android client is
 * not that — nobody's organization owns it, and picking one would make a customer's row the thing
 * that governs whether the platform's own app can sign anyone in.
 *
 * The alternative was inventing a "platform" organization to own it. That is a fiction with a
 * membership table pointing at it, a credit balance, and a row in every listing that filters by
 * organization — a lot of surface for one client.
 *
 * ## The constraint is what stops this becoming a hole
 *
 * Nullable columns alone would let a *customer's* client be registered with no owner, and an
 * unowned third-party client is one nothing can revoke and no audit trail can attribute. So the two
 * cases are stated together: first-party has no owner, third-party must have one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("oauth_client")
    .alterColumn("organization_id", (col) => col.dropNotNull())
    .execute()
  await db.schema
    .alterTable("oauth_client")
    .alterColumn("owner_user_id", (col) => col.dropNotNull())
    .execute()

  await sql`
    alter table oauth_client add constraint oauth_client_ownership_check
      check (
        (is_first_party = true and organization_id is null and owner_user_id is null)
        or
        (is_first_party = false and organization_id is not null and owner_user_id is not null)
      )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table oauth_client drop constraint if exists oauth_client_ownership_check`.execute(
    db,
  )

  /*
    Refuses rather than deletes.

    Reversing this means making the columns `not null` again, and a first-party client has nothing
    to put in them. Deleting those rows to make the migration reversible would silently remove the
    registration the Android client signs in through — so this stops and says what is in the way.
  */
  const firstParty = await sql<{
    count: string
  }>`select count(*)::text as count from oauth_client where organization_id is null`.execute(db)

  if (Number(firstParty.rows[0]?.count ?? "0") > 0) {
    throw new Error(
      "There are first-party OAuth clients with no owning organization. Reversing this migration " +
        "would require deleting them, which would break sign-in for the clients that use them. " +
        "Remove them deliberately first if that is what you want.",
    )
  }

  await db.schema
    .alterTable("oauth_client")
    .alterColumn("organization_id", (col) => col.setNotNull())
    .execute()
  await db.schema
    .alterTable("oauth_client")
    .alterColumn("owner_user_id", (col) => col.setNotNull())
    .execute()
}
