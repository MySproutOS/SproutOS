import { type Kysely, sql } from "kysely"

/**
 * A Neon compute endpoint: the Postgres process a customer actually connects to.
 *
 * A timeline is storage. It answers page requests and holds no session, no connection, and no
 * running query. What a customer connects to is a *compute* — a Postgres started against that
 * timeline by `compute_ctl` — and the whole economic argument for this architecture is that the
 * compute can be absent while the timeline is not.
 *
 * This table is the difference between those two facts. It exists so that a connection arriving for
 * a suspended endpoint has somewhere to look to find out that the endpoint is real, which timeline
 * it belongs to, and whether something is already starting it.
 *
 * ## Why `state` and not just a nullable host
 *
 * Because two connections arriving at once for the same suspended endpoint must not start two
 * computes — they would both attach to the same timeline and Postgres would be running twice
 * against one set of pages. `starting` is a claim, taken with a conditional update, and the loser
 * waits for the winner rather than racing it.
 *
 * ## `last_active_at`
 *
 * What suspension is decided on. Not written by this table's owner: the proxy stamps it, because the
 * control plane does not see queries.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("neon_endpoint")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade"),
    )
    .addColumn("tenant_id", "text", (col) => col.notNull())
    .addColumn("timeline_id", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("suspended"))
    /** Where the compute answers, when one is running. Null whenever it is not. */
    .addColumn("host", "text")
    .addColumn("port", "integer")
    /** The launcher's handle on the process — a container id, or a pod name. */
    .addColumn("runtime_ref", "text")
    .addColumn("last_active_at", "timestamptz")
    .addColumn("started_at", "timestamptz")
    .addColumn("suspended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "neon_endpoint_state_check",
      sql`state in ('suspended', 'starting', 'running', 'error')`,
    )
    .addCheckConstraint("neon_endpoint_tenant_check", sql`tenant_id ~ '^[0-9a-f]{32}$'`)
    .addCheckConstraint("neon_endpoint_timeline_check", sql`timeline_id ~ '^[0-9a-f]{32}$'`)
    /*
      One endpoint per timeline.

      Two computes against one timeline is two Postgres processes writing the same pages. The
      safekeepers would reject the second's WAL, but only after it had already accepted client
      connections and told them their transactions committed.
    */
    .addUniqueConstraint("neon_endpoint_timeline_key", ["tenant_id", "timeline_id"])
    .execute()

  await db.schema
    .createIndex("neon_endpoint_backend_service_id_idx")
    .on("neon_endpoint")
    .column("backend_service_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("neon_endpoint").execute()
}
