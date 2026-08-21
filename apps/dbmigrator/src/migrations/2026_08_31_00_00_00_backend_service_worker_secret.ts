import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Record that a queue's broker URI was captured into a Secret the platform can start a worker with.
 *
 * A worker started on a customer's behalf has to authenticate to their queue, and the platform
 * cannot rebuild the URI: `service_credential` stores a hash, deliberately. So the plaintext is
 * captured at the one moment it exists — provisioning, or a rotation the customer asked for — and
 * written into a Secret in the tenant's namespace.
 *
 * `dispatchQueues` then has to know whether that Secret exists. The obvious way is to ask
 * Kubernetes, and that is the reason this column exists instead: **reading a Secret requires `get`
 * on secrets**, and granting the control plane that means a compromised API pod can read every
 * credential in every tenant namespace. The grant is `create` and `patch` only — the platform can
 * write a Secret and cannot read one back, including its own.
 *
 * So the platform records what it did. The column is a timestamp rather than a boolean because
 * "when" answers a question a boolean cannot: a Secret written before a credential rotation is a
 * Secret holding a URI that no longer works.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table backend_service
      add column worker_secret_at timestamptz
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table backend_service drop column worker_secret_at`.execute(db)
}
