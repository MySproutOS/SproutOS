import { type Kysely, sql } from "kysely"

/**
 * The two preferences the profile screen has been showing as fixtures.
 *
 * `user_preference` already held what the *chrome* remembers — which organization you were last in,
 * whether the sidebar is collapsed. These two are what the *person* chose, and they belong in the
 * same row: one table, one writer, one round trip to render a settings page.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("user_preference")
    /**
     * An IANA zone name, used to render timestamps in the user's own time.
     *
     * Stored, not derived from the browser. A person who works across zones wants their reports in
     * one of them, and `Intl.DateTimeFormat().resolvedOptions().timeZone` follows the laptop rather
     * than the choice. The default matches what a browser reports for someone who has never opened
     * this screen.
     */
    .addColumn("timezone", "text", (col) => col.notNull().defaultTo("UTC"))
    /**
     * Whether we may send product email — announcements, not transactional.
     *
     * Defaults to **false**. An opt-out default puts the burden of consent on the person who never
     * visited this page, and there is no version of that which is worth the extra open rate.
     */
    .addColumn("product_emails", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .execute()

  /*
    A zone has to be one Postgres itself recognises.

    Not a cosmetic check: `timezone` reaches `at time zone` in reporting queries, and an unknown
    zone there is an error in the middle of a statement rather than a bad row anyone can find.
    `pg_timezone_names` is the same list `at time zone` accepts, so the check and the consumer
    cannot disagree.

    A trigger rather than a CHECK constraint, because a CHECK cannot contain a subquery and the
    zone list is a catalogue view rather than a constant. The list also changes with tzdata
    releases, which is the other reason it could never have been a constant.
  */
  await sql`
    create or replace function user_preference_assert_timezone() returns trigger as $$
    begin
      if not exists (select 1 from pg_timezone_names where name = new.timezone) then
        raise exception 'unknown timezone: %', new.timezone using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$ language plpgsql
  `.execute(db)

  await sql`
    create trigger user_preference_timezone_check
      before insert or update of timezone on user_preference
      for each row execute function user_preference_assert_timezone()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists user_preference_timezone_check on user_preference`.execute(db)
  await sql`drop function if exists user_preference_assert_timezone()`.execute(db)
  await db.schema
    .alterTable("user_preference")
    .dropColumn("timezone")
    .dropColumn("product_emails")
    .execute()
}
