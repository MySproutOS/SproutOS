import { type Kysely, sql } from "kysely"

/**
 * Who has committed to a repository, so the team fee can be decided from facts rather than guessed.
 *
 * §2: a flat monthly fee once **more than two distinct people** have committed to a **private**
 * repository. Both halves of that need evidence this schema did not have — the platform receives
 * push webhooks and threw the author away.
 *
 * ## On `repository`, not `project`
 *
 * The requirement says "committing to the repository", and several projects can share one. Counting
 * per project would charge a customer twice for one team working in one place.
 *
 * ## Rows rather than a counter
 *
 * A `committer_count` column would be smaller and cannot answer the question that actually gets
 * asked, which is "who?" — a customer disputing a team fee wants the names, and a count cannot be
 * recomputed for a different window or corrected when a bot slips through the filter.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("repository_committer")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("repository_id", "uuid", (col) =>
      col.references("repository.id").onDelete("cascade").notNull(),
    )
    /*
      The GitHub login, and the email as it appeared in the commit.

      Both, because neither is reliable alone. A commit's author email can be anything the committer
      configured locally; the login is authoritative but is absent when GitHub cannot match the
      email to an account. Counting on email alone charges for one person with two machines; on
      login alone it undercounts the people GitHub could not resolve.
    */
    .addColumn("login", "text")
    .addColumn("email", "text")
    /** What the count keys on: the login where there is one, the email otherwise. */
    .addColumn("identity", "text", (col) => col.notNull())
    /**
     * Excluded from the count.
     *
     * `github-actions[bot]`, dependabot, and anything else whose commits are the platform's own
     * automation. Stored rather than filtered at write time: the rule for what counts as a bot will
     * be wrong at least once, and a row that was never written cannot be recounted.
     */
    .addColumn("is_bot", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("first_seen_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("repository_committer_identity_key", ["repository_id", "identity"])
    .execute()

  // The count query: one repository, recent, not a bot.
  await sql`
    create index repository_committer_recent_idx
      on repository_committer (repository_id, last_seen_at)
      where is_bot = false
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("repository_committer").execute()
}
