import { type Kysely, sql } from "kysely"

/**
 * Config files a forked project needs, which no amount of environment variables can supply.
 *
 * Found by deploying one. `glance` — a real store listing, forked, built and pushed by this
 * platform — started and exited with
 * `parsing config: reading /app/config/glance.yml: no such file or directory`. Everything the
 * platform claims worked: the fork, the build, the image, the push, the revision. The application
 * could not run because it wanted a *file*, and the platform had no way to give it one.
 *
 * That is not one project's quirk. A large share of self-hostable software is configured by a YAML
 * or TOML file and reads nothing from the environment — Caddy, Prometheus, Grafana provisioning,
 * Traefik, and most of the "awesome-selfhosted" catalogue this store is drawn from. A platform whose
 * premise is "fork this and deploy it without knowing how to code" cannot ask its customer to add a
 * Dockerfile stage.
 *
 * ## Shaped like `project_env_var`, deliberately
 *
 * Same sealing convention, same `target` column with the same four values, same cascade. They are
 * the same idea delivered through a different mechanism, and a customer who has understood one
 * should not have to learn the other. It also means the deploy path materializes both the same way:
 * one Secret per revision, named after its contents.
 *
 * ## Why `path` is bare text with a check rather than a parsed thing
 *
 * The path is the container's, not ours: `/app/config/glance.yml` means whatever the image says it
 * means. The constraint only refuses what cannot work — a relative path has no anchor inside the
 * container, and `..` would let a customer mount over `/etc/passwd` in their own container, which is
 * their business, but also over paths the platform relies on in a shared-kernel sandbox.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("project_file")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("path", "text", (col) => col.notNull())
    .addColumn("target", "text", (col) => col.notNull().defaultTo("all"))
    .addColumn("contents_ciphertext", "text", (col) => col.notNull())
    .addColumn("contents_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("contents_kms_key_id", "text", (col) => col.notNull())
    /*
      Sealed whether or not it is secret, unlike `project_env_var.is_secret`.

      A config file is a mixture by nature — `glance.yml` holds layout next to API keys — and asking
      a customer to classify the whole file is asking them to get it wrong in the direction that
      costs something. The column records how to *display* it, not how it is stored.
    */
    .addColumn("is_secret", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("project_file_project_path_target_key", ["project_id", "path", "target"])
    .addCheckConstraint(
      "project_file_target_check",
      sql`target in ('production', 'preview', 'development', 'all')`,
    )
    .addCheckConstraint(
      "project_file_path_check",
      // Absolute, no traversal, no trailing slash, and a name after the last one. Enforced here as
      // well as in the API because the deploy path turns this into a `subPath` mount, and a
      // constraint is the only check that also covers a row written by a migration or by hand.
      sql`path like '/%' and path not like '%/' and path not like '%..%' and length(path) between 2 and 4096`,
    )
    .execute()

  await db.schema
    .createIndex("project_file_project_id_idx")
    .on("project_file")
    .column("project_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_file").execute()
}
