import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * A backend service may have more than one live credential, distinguished by what it is for.
 *
 * ## The problem this removes
 *
 * A queue worker the platform starts on a customer's behalf has to authenticate to that customer's
 * queue. The platform cannot reuse the customer's credential — `service_credential` stores a hash,
 * deliberately, so a stolen table is worthless — and it could not issue a second one either:
 * `service_credential_live_username_key` permits exactly one live row per username, and the username
 * is derived from the resource, so every credential for one service collides.
 *
 * The workaround was to capture the customer's URI as it went past during provisioning. That works
 * for a service provisioned since, and leaves every older one unable to have a worker until the
 * customer rotates — a real limitation dressed up as a policy.
 *
 * ## What replaces it
 *
 * `purpose` — `tenant` for the credential a customer holds, `worker` for one the platform issues to
 * a workload it runs for them. The unique index becomes `(username, purpose)`, so both can be live
 * at once, and `services/valkey-proxy` compares a presented secret against every live credential for
 * the username rather than the first one it finds.
 *
 * Three things follow, and each is an improvement rather than a cost:
 *
 * - **The worker's credential is revocable on its own.** Stopping every platform-started worker for
 *   one service no longer means breaking the customer's application.
 * - **`last_used_at` becomes meaningful again.** One row per consumer, so "when did this credential
 *   last connect" answers a question about one thing.
 * - **A rotation can overlap.** Not used yet, and the constraint no longer forbids it — today
 *   rotating deletes the old credential the instant the new one exists, which drops every live
 *   connection.
 *
 * The default is `tenant`, so every existing row keeps meaning exactly what it meant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table service_credential
      add column purpose text not null default 'tenant'
  `.execute(db)

  await sql`
    alter table service_credential
      add constraint service_credential_purpose_check
      check (purpose in ('tenant', 'worker'))
  `.execute(db)

  /*
    The index is replaced rather than dropped.

    Without a unique constraint at all, a bug that issued two worker credentials would leave two
    live rows and no error — and the proxy, which now accepts any of them, would go on working while
    the platform lost track of which secret is in which Secret. One live credential *per purpose* is
    the invariant that was actually meant.
  */
  await sql`drop index service_credential_live_username_key`.execute(db)
  await sql`
    create unique index service_credential_live_username_purpose_key
      on service_credential (username, purpose)
      where revoked_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Worker credentials cannot exist under the old index — two live rows for one username is exactly
  // what it forbids — so they are revoked rather than left to break the index creation below.
  await sql`
    update service_credential set revoked_at = now()
    where purpose = 'worker' and revoked_at is null
  `.execute(db)

  await sql`drop index service_credential_live_username_purpose_key`.execute(db)
  await sql`
    create unique index service_credential_live_username_key
      on service_credential (username)
      where revoked_at is null
  `.execute(db)
  await sql`alter table service_credential drop constraint service_credential_purpose_check`.execute(
    db,
  )
  await sql`alter table service_credential drop column purpose`.execute(db)
}
