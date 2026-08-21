import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Stop enumerating runtime classes. The cluster owns that set, not this schema.
 *
 * `sandbox_runtime_class_check` has now been wrong three times, and each time the fix was to add the
 * value that had just been discovered:
 *
 * - it permitted `kata-fc` and `kata-clh` only, so recording that a pod got **no** runtime class —
 *   the truth on every cluster without Kata — failed;
 * - `none` was added, and then a GKE Sandbox node pool made `gvisor` the honest answer, which
 *   failed the same way;
 * - and the next cluster will have `runsc`, or `crun`, or a name somebody chose.
 *
 * The pattern is the point. A RuntimeClass is a Kubernetes object created on the cluster, and
 * `SANDBOX_RUNTIME_CLASS` is a free-form environment variable naming one. There is no set of valid
 * values this schema can know: it is trying to own a fact that belongs to the cluster, and every
 * time reality moves, the *truth* is what gets rejected while a stale default stays legal.
 *
 * So the constraint now checks the **shape** — a Kubernetes object name, which is a DNS-1123 label —
 * and nothing else. That still refuses an empty string, a sentence, and anything a RuntimeClass
 * could not be called, which is what a database can honestly enforce here.
 *
 * `none` keeps its meaning: not a runtime class, stated as a word because the column is `not null`
 * and a null would be indistinguishable from "not recorded yet". It happens to be a valid label,
 * which is why this constraint accepts it without a special case.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sandbox drop constraint sandbox_runtime_class_check`.execute(db)
  await sql`
    alter table sandbox
      add constraint sandbox_runtime_class_check
      check (runtime_class ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length(runtime_class) <= 63)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /*
    Back to the enumeration, so rows holding a value it never permitted have to go first.

    Rewritten to `none` rather than deleted: the sandbox those rows describe really did run, and
    "we no longer record which runtime class" is a smaller lie than removing the row.
  */
  await sql`
    update sandbox set runtime_class = 'none'
    where runtime_class not in ('kata-fc', 'kata-clh', 'none')
  `.execute(db)
  await sql`alter table sandbox drop constraint sandbox_runtime_class_check`.execute(db)
  await sql`
    alter table sandbox
      add constraint sandbox_runtime_class_check
      check (runtime_class in ('kata-fc', 'kata-clh', 'none'))
  `.execute(db)
}
