import { type Kysely, sql } from "kysely"

/**
 * The credential a tenant presents to a data-plane proxy.
 *
 * Postgres, Valkey and Elasticsearch all hand a proxy exactly two things at connect time: a
 * username and a secret. There is no room for a token or a header, so the username encodes which
 * resource the connection is for (see `lib/rust/tenant-auth`) and this table is what makes the
 * claim true.
 *
 * **The hash is one-way, unlike `database_role.password_ciphertext`.** That column is reversible
 * because a real Postgres role has to be created on a real server with that exact password —
 * something outside our process needs the plaintext back. Nothing outside our process needs a
 * Valkey secret: the proxy *is* the authenticator, so it only ever needs to answer "does this
 * match", and a stolen table gives an attacker nothing to connect with.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("service_credential")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    /**
     * The connection username, `<kind>_<resource>.<organization>`.
     *
     * Stored rather than derived so the proxy's lookup is one indexed equality on the exact bytes
     * the client sent. Deriving it would mean parsing untrusted input into ids and trusting the
     * parse — and every proxy would have to agree, forever, on the same spelling.
     */
    .addColumn("username", "text", (col) => col.notNull())
    /**
     * `sha256$<hex>` for a secret we generated, or an Argon2 PHC string for one a human chose.
     * The stored value names its own algorithm; see `verify_secret` in `lib/rust/tenant-auth`.
     */
    .addColumn("secret_hash", "text", (col) => col.notNull())
    /** Shown in the dashboard so a user can tell two credentials apart without revealing either. */
    .addColumn("last_four", "text", (col) => col.notNull())
    .addColumn("last_used_at", "timestamptz")
    .addColumn("expires_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await sql`create index service_credential_backend_service_id_idx on service_credential (backend_service_id)`.execute(
    db,
  )

  /*
    The proxy's lookup, and the guard that makes it safe.

    Every authentication is `where username = $1 and revoked_at is null`. One live row per username
    is what makes that a lookup rather than a search: with two, a revoked secret could keep working
    silently for as long as nobody looked at the table.

    `where revoked_at is null` is what lets revoked rows accumulate at all, which is what makes a
    credential's history — issued when, revoked when, last used when — answerable after the fact.

    Note that this is an *index* and not a constraint, because a constraint cannot be partial. So it
    cannot be `DEFERRABLE` either, and Postgres evaluates it per statement: a rotation has to revoke
    before it inserts. Inside one transaction that is not a window anyone can observe — see
    `rotateCredentials` in `@lib/services/valkey`.
  */
  await sql`
    create unique index service_credential_live_username_key on service_credential (username)
      where revoked_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("service_credential").execute()
}
