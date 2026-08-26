import { type Kysely, sql } from "kysely"

/**
 * Logical grouping: a project that holds other projects instead of deploying.
 *
 * A repository with a Next.js app and a separate Hono API is one repository and two deployables,
 * and until now it was two unrelated projects whose relationship lived in a naming convention. The
 * group is the repository; its children are the deployable targets inside it.
 *
 * **A group is still a project.** One table, one boolean — not a second entity with its own routes,
 * permissions and list queries. What `is_group` buys is the absence of a deploy affordance, and
 * nothing else: a group has no artifact, no hostname, and no Lambda.
 *
 * No CHECK constraint forbidding a group a repository, because a group *has* one — that is the
 * whole idea, and it is why `repository_id` can stay `not null` and this migration does not have to
 * rewrite it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    /** Holds children; deploys nothing. */
    .addColumn("is_group", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    /*
      The group this project belongs to.

      `restrict`, emphatically not `cascade`. A group is a piece of organisation, and deleting one
      must never be a way to destroy four deployed services by accident — the caller has to say what
      happens to the children first. Cascade here would make a mis-click unrecoverable.
    */
    .addColumn("parent_project_id", "uuid", (col) =>
      col.references("project.id").onDelete("restrict"),
    )
    /*
      Which deployment is currently serving.

      The platform already tracks this in Valkey as `live:<project id>`, and that key is a cache
      with a 24-hour expiry — it cannot be what a screen reads, and it cannot be what a rollback
      repoints. `deployment.url`/`hostname` say where a deployment *went*; this says which one is
      live now, which is a different fact and the one the overview card needs.
    */
    .addColumn("live_deployment_id", "uuid", (col) =>
      col.references("deployment.id").onDelete("set null"),
    )
    .execute()

  await sql`create index project_parent_project_id_idx on project (parent_project_id)`.execute(db)
  await sql`create index project_live_deployment_id_idx on project (live_deployment_id)`.execute(db)

  /*
    Groups sit outside the one-project-per-build-target rule.

    `project_repository_target_live_key` is unique on (organization, repository, root_dir,
    production_branch) — which is right for deployables, and wrong for groups: a group's `root_dir`
    is `.` by definition, so a second group on the same repository would collide with the first.
    More than one group per repository is deliberate, so groups are excluded from the constraint
    rather than the constraint weakened for everyone.
  */
  await sql`drop index if exists project_repository_target_live_key`.execute(db)
  await sql`
    create unique index project_repository_target_live_key on project
      (organization_id, repository_id, root_dir, production_branch)
      where deleted_at is null and is_group = false
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists project_repository_target_live_key`.execute(db)
  await sql`
    create unique index project_repository_target_live_key on project
      (organization_id, repository_id, root_dir, production_branch) where deleted_at is null
  `.execute(db)

  await sql`drop index if exists project_parent_project_id_idx`.execute(db)
  await sql`drop index if exists project_live_deployment_id_idx`.execute(db)

  await db.schema
    .alterTable("project")
    .dropColumn("is_group")
    .dropColumn("parent_project_id")
    .dropColumn("live_deployment_id")
    .execute()
}
