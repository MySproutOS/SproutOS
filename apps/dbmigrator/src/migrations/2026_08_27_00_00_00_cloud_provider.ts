import { type Kysely, sql } from "kysely"

/**
 * Which cloud a thing is in.
 *
 * `region.code` was a bare string — `us-east-1` — and that is only unambiguous while there is one
 * cloud. AWS `us-east-1`, Azure `eastus` and GCP `us-central1` are different places on different
 * providers, and two of them can be equally close to a customer.
 *
 * The product decision this serves: the control plane lives on AWS, and a customer chooses where
 * their own backends and workflows run. That choice has to be recorded somewhere, and it cannot be
 * inferred from a region string without a lookup table that would immediately disagree with itself.
 *
 * Three columns, each for something that was previously impossible to answer:
 *
 *   - `region.provider` — which cloud a region belongs to.
 *   - `cluster.registry` — where that cluster pulls images from. Not a global constant: pulling an
 *     image across clouds works (verified: a GKE node pulled from AWS ECR) and costs cross-cloud
 *     egress on every pull, and the ECR credential it needs expires after twelve hours. A cluster
 *     pulls from its own cloud's registry.
 *   - `deployment.cluster_id` — where a deployment actually ran. Without it, a deployment's own row
 *     cannot answer which cloud served it, which is a question both billing and support ask.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("region")
    .addColumn("provider", "text", (column) => column.notNull().defaultTo("aws"))
    .execute()

  /*
    `aws` as the default, because every region that exists today is one.

    A nullable column would have been the cautious choice and the wrong one: every read would then
    have to decide what a null provider means, and the honest answer is that the rows written before
    this migration were all AWS.
  */
  await sql`
    alter table region
      add constraint region_provider_check
      check (provider in ('aws', 'gcp', 'azure'))
  `.execute(db)

  // The pair, not the code alone. `us-east-1` on two providers is two regions; `us-east-1` twice on
  // AWS is a mistake.
  await sql`alter table region drop constraint if exists region_code_key`.execute(db)
  await db.schema
    .createIndex("region_provider_code_key")
    .on("region")
    .columns(["provider", "code"])
    .unique()
    .execute()

  await db.schema.alterTable("cluster").addColumn("registry", "text").execute()

  await db.schema
    .alterTable("deployment")
    .addColumn("cluster_id", "uuid", (column) =>
      // `set null`, not `cascade`. A cluster being decommissioned must not delete the record of what
      // ran on it — `usage_event` references these deployments, and ADR 0017 exists because billing
      // history outlives the infrastructure it describes.
      column.references("cluster.id").onDelete("set null"),
    )
    .execute()

  await db.schema
    .createIndex("deployment_cluster_id_idx")
    .on("deployment")
    .column("cluster_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("deployment_cluster_id_idx").execute()
  await db.schema.alterTable("deployment").dropColumn("cluster_id").execute()
  await db.schema.alterTable("cluster").dropColumn("registry").execute()
  await db.schema.dropIndex("region_provider_code_key").execute()
  await sql`alter table region drop constraint if exists region_provider_check`.execute(db)
  await db.schema.alterTable("region").dropColumn("provider").execute()
  await db.schema.createIndex("region_code_key").on("region").column("code").unique().execute()
}
