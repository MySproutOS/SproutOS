import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Object storage, as a fifth backend service kind.
 *
 * `obsidian-livesync` replicates against either a CouchDB or an S3-compatible bucket, and a customer
 * should be able to pick — the CouchDB is a server somebody has to run, and a bucket is not.
 *
 * The kind is `object_storage` rather than `s3`, because the protocol is not the product. AWS S3,
 * GCS's XML API, MinIO, R2 and LocalStack all speak it, and the tenancy differs only in how the
 * credential is issued.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch', 'couchdb', 'object_storage'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from backend_service where kind = 'object_storage'`.execute(db)
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch', 'couchdb'))
  `.execute(db)
}
