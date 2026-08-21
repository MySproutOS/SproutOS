import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * CouchDB is withdrawn as a backend service kind.
 *
 * It was added with an argument that reads well and is the wrong shape for this platform: that
 * CouchDB's own `_security` object and `require_valid_user` are the tenant boundary, so a proxy
 * would add a component that can be wrong about a decision the server already makes correctly.
 *
 * The narrow claim held up when probed — a second tenant's credential answers 403 on the first
 * tenant's database, `/_all_dbs` answers 401 to a non-admin, and `PUT /somedb` is refused. What
 * does not hold is the conclusion drawn from it. Every other tenant-facing datastore here sits
 * behind a proxy — `pg-proxy`, `valkey-proxy`, `search-proxy` — and that is not three separate
 * decisions about three databases. It is one decision about the platform: **a tenant never gets a
 * route to the datastore itself.**
 *
 * Exposing CouchDB directly means exposing its whole HTTP surface to the internet, and the boundary
 * then rests on a third party's configuration staying correct forever. `/_utils` — Fauxton, the
 * admin UI — answered 200 to an unauthenticated request on the very first probe, which is harmless
 * on its own and is exactly the kind of surface a proxy exists to remove. Every future CouchDB CVE
 * would be reachable by anyone, and the platform would find out about it the way everyone does.
 *
 * `obsidian-livesync` — the request that prompted the kind — replicates against an S3-compatible
 * bucket as well as a CouchDB, so nothing is lost by keeping the object-storage path and dropping
 * this one.
 *
 * No rows are deleted because the kind never reached a deployed environment; the `delete` is here
 * so a local database that did provision one comes back to a consistent state.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`delete from backend_service where kind = 'couchdb'`.execute(db)
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch', 'object_storage'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table backend_service drop constraint backend_service_kind_check`.execute(db)
  await sql`
    alter table backend_service
      add constraint backend_service_kind_check
      check (kind in ('postgres', 'valkey', 'elasticsearch', 'couchdb', 'object_storage'))
  `.execute(db)
}
