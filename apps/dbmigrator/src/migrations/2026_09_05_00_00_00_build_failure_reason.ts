import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Why a build failed, where a customer can read it.
 *
 * The handler threw `Build failed for deployment <uuid>` and that string was the whole record. It
 * reached the job's `last_error` and nowhere else — not the API, not the dashboard, not the
 * `deployment_build` row that exists to describe the build.
 *
 * Every genuine build failure this platform has had needed a `kubectl logs` to explain:
 *
 * - `failed to read dockerfile: open Dockerfile: no such file or directory` — the store listing
 *   pointed at a repository that keeps its Dockerfile in `docker/`.
 * - `failed to authorize: failed to fetch anonymous token: … 403 Forbidden` — the push credential
 *   that had never existed.
 * - `0/3 nodes are available: 2 Insufficient cpu` — a build that never started at all, retried five
 *   times and dead-lettered under a message that said "Build failed" and implied it had run.
 *
 * Each of those tells the person exactly what to change, and each was available at the moment the
 * platform gave up and threw it away. The last one is the reason this is not just "tail the logs":
 * a pod that never started has no logs, and its reason lives in the pod's status.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table deployment_build
      add column failure_reason text
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployment_build drop column failure_reason`.execute(db)
}
