import { type Kysely, sql } from "kysely"

/**
 * A programmatic key for the SproutOS API itself.
 *
 * Distinct from the two other credentials in this schema, and the distinction matters:
 *
 * - `agent_credential` holds a customer's key for *someone else's* AI provider. We store it
 *   encrypted because we have to send it to Anthropic or OpenAI.
 * - `oauth_client_secret` belongs to a third-party application acting on a user's behalf, with a
 *   consent screen and a refresh cycle.
 * - This is the customer's own key for their own scripts. No consent screen, no refresh — a long
 *   lived secret they paste into CI.
 *
 * **Its power is the intersection of two things**, exactly as an OAuth token's is: what the user
 * can do, and what the key was granted. Either alone is wrong. Scopes alone would let a key keep
 * `org:delete` after its creator is demoted to member. RBAC alone makes the scopes decorative, so a
 * key made for a read-only CI job could delete a project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("api_key")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    /**
     * Who the key acts as.
     *
     * `restrict`, not `cascade`: deleting a user whose key is still in a customer's CI would leave
     * a live credential whose permissions cannot be evaluated. Revoking the keys is part of
     * removing the person, and this makes forgetting that an error rather than a silent hole.
     */
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("restrict").notNull())
    .addColumn("name", "text", (col) => col.notNull())
    /** `sha256$<hex>`. One-way — see `lib/typescript/api-keys`. */
    .addColumn("key_hash", "text", (col) => col.notNull())
    /**
     * The first characters, shown in the list so a person can tell two keys apart.
     *
     * Enough to recognise, far too little to use: the secret is 256 bits and this is eight
     * characters of it.
     */
    .addColumn("prefix", "text", (col) => col.notNull())
    /**
     * The RBAC actions this key was granted, intersected with the user's own at every request.
     *
     * `["*"]` is allowed and means "everything the user can do" — which is what a personal
     * automation key usually wants, and which still shrinks when the user is demoted.
     */
    .addColumn("scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("last_used_at", "timestamptz")
    .addColumn("expires_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`create index api_key_organization_id_idx on api_key (organization_id)`.execute(db)
  await sql`create index api_key_user_id_idx on api_key (user_id)`.execute(db)

  /*
    The lookup, and the guard that makes it a lookup.

    Every authenticated request is `where key_hash = $1`, so the hash has to be unique — two rows
    sharing one would make authentication ambiguous, and whichever the planner returned first would
    decide a customer's permissions.

    Not partial on `revoked_at`: a revoked key's hash must stay reserved. Allowing a second row with
    the same hash after a revocation would mean a revoked secret could be made to work again.
  */
  await sql`create unique index api_key_key_hash_key on api_key (key_hash)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("api_key").execute()
}
