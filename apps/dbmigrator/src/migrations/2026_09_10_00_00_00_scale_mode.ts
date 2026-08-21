import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Cold start, or keep one warm. See ADR 0024.
 *
 * On both tables, and the reason is the one `deployment.runtime_class` teaches: the project's
 * column is the customer's *setting* and the deployment's is what a given revision actually ran
 * with. A deployment is a historical fact, and reading the mode off the project would let a
 * settings change silently re-describe every deploy that came before it.
 *
 * `cold` by default, because the platform's premise is that idle costs nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table project
      add column scale_mode text not null default 'cold'
        constraint project_scale_mode_check check (scale_mode in ('cold', 'warm'))
  `.execute(db)

  await sql`
    alter table deployment
      add column scale_mode text not null default 'cold'
        constraint deployment_scale_mode_check check (scale_mode in ('cold', 'warm'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployment drop column scale_mode`.execute(db)
  await sql`alter table project drop column scale_mode`.execute(db)
}
