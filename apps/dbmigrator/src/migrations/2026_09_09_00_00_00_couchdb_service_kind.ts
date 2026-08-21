import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * CouchDB, as a fourth backend service kind.
 *
 * Prompted by a concrete request — deploying `vrtmrz/obsidian-livesync`, whose repository is an
 * Obsidian plugin and whose *deployable* half is a CouchDB instance the plugin replicates against.
 * There is nothing to build and nothing to serve; what a customer needs is a database with a
 * connection URI, which is what `backend_service` is for.
 *
 * It is a genuinely different shape from the three that exist, in a way worth writing down:
 *
 * - **It needs no proxy to be multi-tenant.** `pg-proxy`, `valkey-proxy` and `search-proxy` exist
 *   because Postgres roles, Valkey keyspaces and OpenSearch OSS indices cannot be made to enforce
 *   one customer's boundary on their own. CouchDB can: a database carries a `_security` object
 *   naming its members, and `require_valid_user` refuses everything else. The boundary is the
 *   server's, and adding a proxy would be adding a thing to get wrong.
 * - **The customer's client connects to it directly, from a browser-shaped runtime.** Obsidian
 *   sends `Origin: app://obsidian.md`, so the instance has to answer CORS for an origin that is not
 *   a web page. That is configuration on the server, not something a driver can paper over.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch', 'couchdb'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from backend_service where kind = 'couchdb'`.execute(db)
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch'))
  `.execute(db)
}
