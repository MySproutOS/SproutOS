import { type Kysely, sql } from "kysely"

/**
 * Whether a deployment's artifact is an HTTP server rather than a Lambda handler.
 *
 * A historical fact about the build, so it belongs on the deployment and not on the project — the
 * same reasoning `runtime`, `handler`, `scale_mode` and `runtime_class` already carry. It is what
 * makes rollback correct: republishing an old version must attach the adapter if that version was
 * built expecting it, and reading the flag off the project would let a preset change re-describe a
 * release that already ran.
 *
 * Defaults to `false` so every row written before this migration keeps meaning exactly what it said.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("deployment")
    .addColumn("web_adapter", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("deployment").dropColumn("web_adapter").execute()
}
