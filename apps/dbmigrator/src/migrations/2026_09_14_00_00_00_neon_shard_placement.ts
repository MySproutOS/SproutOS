import { type Kysely, sql } from "kysely"

/**
 * Where each Neon tenant's data is attached, as the storage controller reports it.
 *
 * ## Why this table has to exist to self-host Neon at all
 *
 * Neon's storage controller decides which pageserver holds which tenant shard, and it *tells the
 * control plane* — that is not optional and not advisory. With no `--control-plane-url` the
 * controller panics on the first attach:
 * `called \`Option::unwrap()\` on a \`None\` value` in `compute_hook.rs`, after the tenant has
 * already been created and attached. With a URL that answers anything but 200 it retries forever and
 * the reconcile never completes.
 *
 * So a control plane is not something you add on top of Neon's storage layer. It is a component the
 * storage layer requires, and this table is the state it exists to keep: the compute for a tenant
 * has to be pointed at the pageserver currently holding it, and only the controller knows which.
 *
 * The contract was read off the controller's own log rather than its source:
 *
 * ```
 * PUT {control_plane_url}/notify-attach
 * { "tenant_id": "<32 hex>", "preferred_az": "local", "stripe_size": null,
 *   "shards": [ { "node_id": 1, "shard_number": 0 } ] }
 * ```
 *
 * ## Keyed on `(tenant_id, shard_number)`
 *
 * A tenant is one row until it is split. Sharding is how Neon handles a database that outgrows one
 * pageserver, and the notification carries every shard each time — so the write is "replace this
 * tenant's placement", not "insert one row".
 *
 * `tenant_id` is Neon's own 32-character hex, not a SproutOS uuid. It is deliberately not a foreign
 * key: this row is written by an upcall that must succeed before the tenant is usable, and the
 * `database_instance` that will reference it may not exist yet — the controller can attach a tenant
 * during a retry, out of order with anything this platform is doing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("neon_shard_placement")
    .addColumn("tenant_id", "text", (col) => col.notNull())
    .addColumn("shard_number", "int2", (col) => col.notNull())
    .addColumn("node_id", "integer", (col) => col.notNull())
    .addColumn("preferred_az", "text")
    .addColumn("stripe_size", "integer")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("neon_shard_placement_pkey", ["tenant_id", "shard_number"])
    .addCheckConstraint("neon_shard_placement_tenant_check", sql`tenant_id ~ '^[0-9a-f]{32}$'`)
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("neon_shard_placement").execute()
}
