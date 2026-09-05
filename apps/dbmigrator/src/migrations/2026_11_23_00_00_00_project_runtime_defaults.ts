import { sql, type Kysely } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .addColumn("deployment_preset", "text")
    .addColumn("runtime", "text")
    .addColumn("handler", "text")
    .execute()

  await sql`
    with chosen as (
      select distinct on (p.id)
             p.id as project_id,
             d.preset,
             d.runtime,
             d.handler
        from project as p
        join deployment as d on d.project_id = p.id
       where p.deleted_at is null
         and p.is_group = false
         and p.kind <> 'workflow'
         and d.deleted_at is null
         and d.preset not in ('static', 'android')
         and d.runtime is not null
       order by p.id, (d.id = p.live_deployment_id) desc, d.created_at desc
    )
    update project as p
       set deployment_preset = chosen.preset,
           runtime = case
             when chosen.runtime like 'nodejs%' then 'nodejs24.x'
             else chosen.runtime
           end,
           handler = chosen.handler,
           updated_at = now()
      from chosen
     where p.id = chosen.project_id
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .dropColumn("handler")
    .dropColumn("runtime")
    .dropColumn("deployment_preset")
    .execute()
}
