import { type Kysely, sql } from "kysely"

/**
 * APKs waiting to be signed.
 *
 * **The platform does not hold the Android signing key**, and this table is the consequence of that
 * decision. A dedicated on-premises server holds it, polls for work, downloads the unsigned APK,
 * signs it, and uploads the result. The key never reaches AWS, never reaches a CI runner, and never
 * reaches this repository.
 *
 * That is a materially better arrangement than the platform signing, and it is worth saying why:
 * SproutOS is developer of record for every app it publishes, so its signing key is the identity of
 * every customer app at once. A key on a machine that also serves public HTTP is a key with an
 * enormous attack surface for what it protects.
 *
 * ## Why a queue and not a callback
 *
 * The signer is on somebody's premises behind a firewall. It can reach out; nothing can reach in.
 * So the platform cannot push work to it and the signer polls — which also means the signer can be
 * offline for a day without anything being lost, and a build queued during that time is simply
 * signed late.
 *
 * ## `claimed_at` and `claimed_by`
 *
 * A claim, not a lock. Two signers, or one signer restarted mid-job, must not both sign the same
 * artifact — not because two signatures are dangerous, but because the second upload would race the
 * first and the app store could serve either. The claim is taken with a conditional update and
 * expires, so a signer that dies holding one does not block the queue forever.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("apk_signing_job")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("deployment_id", "uuid", (col) =>
      col.references("deployment.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    /** Where the unsigned APK is, and where the signed one goes. Both object-storage keys. */
    .addColumn("unsigned_key", "text", (col) => col.notNull())
    .addColumn("signed_key", "text")
    /** sha256 of the unsigned artifact, so the signer can verify what it downloaded. */
    .addColumn("unsigned_digest", "text", (col) => col.notNull())
    .addColumn("signed_digest", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("claimed_by", "text")
    .addColumn("claimed_at", "timestamptz")
    .addColumn("signed_at", "timestamptz")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "apk_signing_job_status_check",
      sql`status in ('pending', 'claimed', 'signed', 'failed')`,
    )
    /*
      One job per deployment.

      A deployment produces one APK. Two rows would mean two signers each producing a signed
      artifact for the same release, and whichever uploaded last would win — silently.
    */
    .addUniqueConstraint("apk_signing_job_deployment_key", ["deployment_id"])
    .execute()

  // The poll query: oldest pending first. Partial, because `signed` rows accumulate forever and a
  // signer never looks at them.
  await sql`
    create index apk_signing_job_pending_idx on apk_signing_job (created_at)
      where status = 'pending'
  `.execute(db)

  await db.schema
    .createIndex("apk_signing_job_project_id_idx")
    .on("apk_signing_job")
    .column("project_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("apk_signing_job").execute()
}
