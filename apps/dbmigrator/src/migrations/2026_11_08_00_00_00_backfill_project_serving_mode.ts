import { sql, type Kysely } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update project as p
       set serving_mode = case
         when d.preset = 'static' or d.static_artifact_key is not null then 'static'
         when d.lambda_version is not null then 'serverless'
       end,
       updated_at = now()
      from deployment as d
     where d.id = p.live_deployment_id
       and d.deleted_at is null
       and p.deleted_at is null
       and p.is_group = false
       and p.serving_mode is null
       and (
         d.preset = 'static'
         or d.static_artifact_key is not null
         or d.lambda_version is not null
       )
  `.execute(db)
}

export async function down(): Promise<void> {}
