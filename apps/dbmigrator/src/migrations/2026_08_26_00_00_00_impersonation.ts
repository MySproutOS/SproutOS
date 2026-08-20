import { type Kysely, sql } from "kysely"

/**
 * Who was really at the keyboard.
 *
 * A platform admin sometimes has to see a customer's account as the customer sees it — a bug that
 * only reproduces under one organization's data, a support question about a screen nobody else can
 * reach. Doing that by reading the database is worse than impersonation, not better: it is
 * unaudited, it is ad hoc, and it tempts a `psql` session with write access on production.
 *
 * So impersonation is a supported thing, and these two columns are the price of it. Without them a
 * customer's audit trail would record their own id doing something they did not do, which turns the
 * one record that exists to answer "who did this" into a record that answers it wrongly.
 *
 * `restrict` on both, like every other `user` reference: an impersonator who later closes their
 * account must not take the evidence with them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  /*
    On the session, because impersonation is a property of the *connection*, not of the person.

    The alternative — a flag on the admin's own session, with the target passed per request — means
    every route has to remember to look for it, and the one that forgets is the one that writes an
    unattributed row. Minting a separate session for the target user makes the impersonated identity
    the ordinary one: every existing route authenticates it the way it authenticates anybody, and
    the only thing that changes is that this column is not null.
  */
  await db.schema
    .alterTable("session")
    .addColumn("impersonated_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict"),
    )
    .execute()

  await db.schema
    .alterTable("audit_log")
    .addColumn("impersonator_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict"),
    )
    .execute()

  /*
    "Show me everything done while impersonating this month" and "show me everything this admin did
    as somebody else" are the two questions an incident review asks, and both are the same index.
    Partial, because the overwhelming majority of audit rows are nobody impersonating anybody.
  */
  await sql`
    create index audit_log_impersonator_idx
      on audit_log (impersonator_user_id, created_at desc)
      where impersonator_user_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists audit_log_impersonator_idx`.execute(db)
  await db.schema.alterTable("audit_log").dropColumn("impersonator_user_id").execute()
  await db.schema.alterTable("session").dropColumn("impersonated_by_user_id").execute()
}
