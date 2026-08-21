import type { Kysely } from "kysely"

/**
 * Where a project's own workloads run.
 *
 * The control plane lives on AWS. A customer's backends and workflows do not have to: the product
 * decision is that they choose, and until now there was nowhere to record the choice.
 *
 * Nullable, and that is the interesting part. A null region means "wherever the platform puts you",
 * which is the right default for someone who has never thought about it and must stay valid
 * afterwards — a customer who has not chosen is not the same as a customer whose choice was lost,
 * and a `not null` column with a default would make those two indistinguishable the first time a
 * region was retired.
 *
 * `restrict` on delete, like `cluster.region_id` and `backend_service.region_id`: a region with
 * projects pointing at it cannot be removed until they have been moved, which is a migration
 * somebody has to perform rather than a cascade that performs it silently.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .addColumn("region_id", "uuid", (column) => column.references("region.id").onDelete("restrict"))
    .execute()

  await db.schema.createIndex("project_region_id_idx").on("project").column("region_id").execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("project_region_id_idx").execute()
  await db.schema.alterTable("project").dropColumn("region_id").execute()
}
