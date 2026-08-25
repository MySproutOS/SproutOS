import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * `sandbox` stops describing a pod and starts describing a rented sandbox.
 *
 * The table was written for Knative and Kata: `pod_name`, `namespace`, `pvc_name`, and a
 * `runtime_class` naming a Kubernetes RuntimeClass. ADR 0026 deleted the cluster and commit
 * `2249bad` deleted the only code that would have written those columns, so every one of them has
 * been unwritable since — not stale, unreachable.
 *
 * Sandboxes now come from Daytona Cloud. What the control plane needs to record is which provider
 * holds the sandbox, that provider's id for it, and the resource shape we asked for — because
 * `sandbox.meter` bills from the shape and our own start/stop timestamps rather than from a vendor
 * invoice, which is ADR 0014's rule that money never rides the telemetry path.
 *
 * ## Why `runtime_class` goes rather than staying nullable
 *
 * ADR 0012's amendment is the reason it existed: the column said `kata-clh` while
 * `sandboxRuntimeClass()` returned `undefined`, so customer code ran in an ordinary container and
 * the database claimed a kernel boundary that was never there. The lesson drawn was to record what
 * the sandbox actually got, not what was requested.
 *
 * Under a rented provider we cannot observe what it got. Daytona operates the isolation and exposes
 * no runtime class. A column that is structurally always `none` does not record that fact — it
 * restates "not known" in a field whose name promises otherwise, which is the same lie in a new
 * outfit. It comes back, writable, if `services/sandbox-runner` is ever built.
 *
 * ## Why `provider` and `sandbox_class` are shape checks, not enumerations
 *
 * `2026_09_02_00_00_00_sandbox_runtime_class_open` already learned this on this exact table:
 * `sandbox_runtime_class_check` was wrong three times, and each time the value being refused was
 * the true one. Daytona's own `SandboxClass` today is `linux-vm | container | android | windows`
 * and is a set they own, not one this schema can know. So the database checks that these look like
 * identifiers and nothing more; `@lib/sandbox` owns which values this platform actually supports,
 * where adding one is a code change that a type checker sees.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sandbox")
    .dropColumn("pod_name")
    .dropColumn("namespace")
    .dropColumn("pvc_name")
    .execute()

  await sql`alter table sandbox drop constraint sandbox_runtime_class_check`.execute(db)
  await db.schema.alterTable("sandbox").dropColumn("runtime_class").execute()

  await db.schema
    .alterTable("sandbox")
    .addColumn("provider", "text", (col) => col.notNull().defaultTo("daytona"))
    // Null until the provider has actually created it. A row exists first so that a create which
    // dies mid-flight is still attributable and still reapable, rather than an orphan nobody bills.
    .addColumn("external_id", "text")
    .addColumn("sandbox_class", "text", (col) => col.notNull().defaultTo("container"))
    // The port the customer's dev server listens on, for the preview link. Null means not serving.
    .addColumn("preview_port", "integer")
    .addColumn("cpu", "integer", (col) => col.notNull().defaultTo(2))
    .addColumn("memory_gib", "integer", (col) => col.notNull().defaultTo(4))
    .addColumn("disk_gib", "integer", (col) => col.notNull().defaultTo(10))
    .execute()

  await sql`
    alter table sandbox
      add constraint sandbox_provider_check
      check (provider ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length(provider) <= 63)
  `.execute(db)

  await sql`
    alter table sandbox
      add constraint sandbox_class_check
      check (sandbox_class ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length(sandbox_class) <= 63)
  `.execute(db)

  /*
    Resources are billed, so a zero or a negative is a free sandbox rather than a validation error.
    Ceilings are deliberately generous — they exist to catch a unit mix-up (MiB passed as GiB) and
    a runaway resize, not to express a product limit, which belongs in organization quotas where it
    can differ per customer.
  */
  await sql`
    alter table sandbox
      add constraint sandbox_resources_check
      check (cpu between 1 and 64 and memory_gib between 1 and 256 and disk_gib between 1 and 1024)
  `.execute(db)

  await sql`
    alter table sandbox
      add constraint sandbox_preview_port_check
      check (preview_port is null or preview_port between 1 and 65535)
  `.execute(db)

  /*
    One row per remote sandbox. Without this a retried provision that lost its response can attach a
    second row to the same Daytona sandbox, and then both rows meter it — the customer pays twice
    for one container, and the second charge looks exactly like a real one.

    Partial, because `external_id` is null for the window between insert and create.
  */
  await sql`
    create unique index sandbox_provider_external_id_key
      on sandbox (provider, external_id)
      where external_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists sandbox_provider_external_id_key`.execute(db)

  await db.schema
    .alterTable("sandbox")
    .dropColumn("provider")
    .dropColumn("external_id")
    .dropColumn("sandbox_class")
    .dropColumn("preview_port")
    .dropColumn("cpu")
    .dropColumn("memory_gib")
    .dropColumn("disk_gib")
    .execute()

  /*
    The Kubernetes columns come back nullable and empty, which is what they were: no row ever held a
    value in them. `runtime_class` returns with the open shape check it had at the end rather than
    the enumeration it started with — going back further would refuse `gvisor` again, and this is a
    rollback, not a re-litigation.
  */
  await db.schema
    .alterTable("sandbox")
    .addColumn("pod_name", "text")
    .addColumn("namespace", "text")
    .addColumn("pvc_name", "text")
    .addColumn("runtime_class", "text", (col) => col.notNull().defaultTo("none"))
    .execute()

  await sql`
    alter table sandbox
      add constraint sandbox_runtime_class_check
      check (runtime_class ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length(runtime_class) <= 63)
  `.execute(db)
}
