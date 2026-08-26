import { type Kysely, sql } from "kysely"

/**
 * Who released this, what they released, and what it runs on.
 *
 * Three unrelated-looking columns that are all the same omission: a deployment row could not answer
 * questions anybody looking at a deployment asks first.
 *
 * `runtime` and `handler` are the load-bearing pair. `publishFunction` hardcoded `nodejs22.x` and
 * `index.handler`, which pinned every customer on the platform to one Node version — a runtime
 * deprecation would have been a platform-wide emergency resolved by grep — and made a Hono API and
 * a Next.js server share a handler neither of them chose.
 *
 * They are stored **on the deployment**, not read off the project at publish time, for the same
 * reason `scale_mode` and `runtime_class` already are: a deployment is a historical fact. Reading
 * the project later would let a settings change re-describe a release that already ran, and would
 * make rollback wrong in a way nobody would notice until it broke — republishing an old version
 * under whatever runtime the project happens to name today, rather than the one it was built for.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("deployment")
    /*
      Nullable, and that is not laziness.

      A deploy through the GitHub Action authenticates as the *repository*, via OIDC — there is no
      user in the exchange at all. Inventing one would be a lie on the very card that exists to say
      who shipped this. Null means "CI did it", and the UI shows the repository instead.
    */
    .addColumn("created_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    /** The commit subject, so a deployment list reads like a history rather than a list of shas. */
    .addColumn("git_message", "text")
    /** Lambda's runtime identifier, e.g. `nodejs22.x`. Validated at the API against Lambda's set. */
    .addColumn("runtime", "text")
    /** The function entry point, e.g. `index.handler`. */
    .addColumn("handler", "text")
    .execute()

  await sql`create index deployment_created_by_user_id_idx on deployment (created_by_user_id)`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists deployment_created_by_user_id_idx`.execute(db)
  await db.schema
    .alterTable("deployment")
    .dropColumn("created_by_user_id")
    .dropColumn("git_message")
    .dropColumn("runtime")
    .dropColumn("handler")
    .execute()
}
