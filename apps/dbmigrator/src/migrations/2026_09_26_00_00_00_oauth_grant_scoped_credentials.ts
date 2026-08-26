import { type Kysely, sql } from "kysely"

/**
 * A database credential belongs to the grant that created it.
 *
 * An OAuth application can already provision a backend service on a user's behalf: `authMiddleware`
 * falls through to a bearer token, `requirePermission` intersects the token's scopes with the user's
 * RBAC, and the route hands back a connection URI. What it could not do is come *back*.
 *
 * `service_credential` keyed on `backend_service_id` alone, so the application and the user held the
 * same secret. Revoking the application's access could not revoke its database access without
 * breaking the user's own URI, and rotating to force the issue broke every other consumer too,
 * because rotation revoked every live credential on the service.
 *
 * So a credential now records the grant it was minted under — null for one the user made themselves
 * — and a service records which application created it. Revoking a grant marks its credentials
 * `revoked_at`, and **every proxy already refuses those**: `lib/rust/service-credentials` filters on
 * that column and all three splits go through it. The enforcement needed no new code, which is the
 * dividend of there being one implementation of "is this secret live".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  /*
    `on delete set null`, not cascade.

    A grant is revoked far more often than it is deleted, and the two must not be confused. But if a
    row ever is deleted, the credential must survive as an orphan rather than vanish — deleting it
    would silently restore access for anybody still holding the secret, because the proxies decide
    on `revoked_at` and a missing row means "no live credential"… which they read as a refusal only
    because the lookup finds nothing. Losing the audit trail of who minted it is the worse outcome.
  */
  await sql`
    alter table service_credential
      add column if not exists oauth_grant_id uuid
        references oauth_grant (id) on delete set null
  `.execute(db)

  await sql`
    alter table backend_service
      add column if not exists created_by_oauth_grant_id uuid
        references oauth_grant (id) on delete set null
  `.execute(db)

  // Revocation walks from a grant to its credentials, and the "what did this app create" listing
  // walks from a grant to its services. Both are the indexed direction.
  await sql`
    create index if not exists service_credential_oauth_grant_id_idx
      on service_credential (oauth_grant_id) where oauth_grant_id is not null
  `.execute(db)

  await sql`
    create index if not exists backend_service_created_by_oauth_grant_id_idx
      on backend_service (created_by_oauth_grant_id) where created_by_oauth_grant_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /*
    Dropping these columns is safe, unlike the price-book rollback next door.

    Nothing here is a charge. The credentials themselves survive with their `revoked_at` intact, so
    a rollback loses the attribution — which application minted which secret — and not the ability
    to refuse a revoked one. Existing URIs keep working exactly as they did before this migration,
    which is the property that makes the rollback uneventful.
  */
  await sql`drop index if exists backend_service_created_by_oauth_grant_id_idx`.execute(db)
  await sql`drop index if exists service_credential_oauth_grant_id_idx`.execute(db)
  await sql`alter table backend_service drop column if exists created_by_oauth_grant_id`.execute(db)
  await sql`alter table service_credential drop column if exists oauth_grant_id`.execute(db)
}
