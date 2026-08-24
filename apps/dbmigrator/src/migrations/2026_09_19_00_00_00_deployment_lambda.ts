import { type Kysely, sql } from "kysely"

/**
 * What a deployment is, now that it is a Lambda and not a Knative revision.
 *
 * ADR 0026 moved customer compute to Lambda. A deployment used to be a container image the cluster
 * pulled; it is now a zip in S3 that Lambda reads, one immutable version per release, with an alias
 * pointing at whichever version is live.
 *
 * The Knative columns — `image_uri`, `knative_revision`, `cluster_id`, `runtime_class` — are left
 * in place rather than dropped. Every one of them is on a row `usage_event` references, and this
 * repository's rule is that anything billing points at is soft-deleted, not destroyed. Dropping
 * them would also make a rollback of *this* migration lossy in the one direction that matters: a
 * deployment history nobody can read is a billing dispute nobody can answer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("deployment")
    /*
      Where the build is. The key inside `SERVICE_BUILD_BUCKET`, written by the deploy action's
      upload step.

      Nullable, because a deployment row exists from the moment the release is recorded and the
      artifact may still be uploading — and because every historical row predates this column.
    */
    .addColumn("artifact_key", "text")
    /** The Lambda version this release published. The rollback target. */
    .addColumn("lambda_version", "text")
    /**
     * The hostname this deployment serves on, as published into the platform Valkey.
     *
     * Stored rather than derived at teardown. Withdrawing a route is how a suspended project stops
     * costing money, and a teardown that recomputed the hostname from the current slug would fail
     * to withdraw anything for a project that had since been renamed — leaving it serving.
     */
    .addColumn("hostname", "text")
    .execute()

  await sql`
    create index deployment_hostname_idx on deployment (hostname)
      where hostname is not null and deleted_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists deployment_hostname_idx`.execute(db)
  await db.schema
    .alterTable("deployment")
    .dropColumn("artifact_key")
    .dropColumn("lambda_version")
    .dropColumn("hostname")
    .execute()
}
