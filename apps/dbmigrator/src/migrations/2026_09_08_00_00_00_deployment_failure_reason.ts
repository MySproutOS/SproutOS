import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Why a deployment failed, where a customer can read it — for the stage they will actually hit.
 *
 * `deployment_build.failure_reason` covers a build that would not build. It does not cover a
 * deployment that built perfectly and then failed to *run*, which is the more common failure by a
 * wide margin: the image is fine and the application will not start.
 *
 * The comment beside that path already said the right thing — "recorded as an error so the customer
 * sees Knative's own message rather than a job that vanished" — and the message went into the
 * thrown error, which reaches `background_job.last_error` and stops there. The row a customer reads
 * said `status: error` and nothing else.
 *
 * The first real one on this platform was worth reading:
 *
 *     Container failed with: parsing config: reading /app/config/glance.yml:
 *     open /app/config/glance.yml: no such file or directory
 *
 * That is not a platform fault and it is exactly what the person who forked the application needs
 * to see — the app wants a config file nobody has given it. Discarding it leaves them with a red
 * badge and no idea whether the problem is theirs or ours.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deployment
      add column failure_reason text
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployment drop column failure_reason`.execute(db)
}
