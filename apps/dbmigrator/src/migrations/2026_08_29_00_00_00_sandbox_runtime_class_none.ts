import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * A sandbox may have no runtime class, and the schema must be able to say so.
 *
 * `sandbox.runtime_class` was `not null default 'kata-clh'` with a check permitting only `kata-fc`
 * and `kata-clh`. So the column could hold two values, both of which assert a hardware-virtualized
 * boundary around the customer's code — and every row said `kata-clh` regardless of what the pod
 * actually got, because that was the default and nothing ever wrote it.
 *
 * On a cluster with no bare-metal node pool there is no `kata-clh` RuntimeClass, `SANDBOX_RUNTIME_CLASS`
 * is unset, and `devSandboxPod` correctly names none. That is a supported configuration, stated as
 * such in `sandboxRuntimeClass`. The isolation is then the tenant namespace, its NetworkPolicies,
 * a pod with no service-account token and no capabilities — real, and *not* a VM.
 *
 * The row said `kata-clh` anyway. `runtime_class` is exactly the column someone queries to answer
 * "did this customer's code run in a VM", and it was answering yes for workloads that ran in a
 * container. Writing the true value failed the check constraint, which is how this was found.
 *
 * Adding `none` is the smaller half. The default is dropped in the same migration: a column whose
 * default asserts an isolation boundary will drift back to lying the moment a writer forgets it,
 * and there is no sensible default for a fact about a pod that has not been created yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sandbox drop constraint sandbox_runtime_class_check`.execute(db)
  await sql`alter table sandbox alter column runtime_class drop default`.execute(db)
  await sql`
    alter table sandbox
      add constraint sandbox_runtime_class_check
      check (runtime_class in ('kata-fc', 'kata-clh', 'none'))
  `.execute(db)

  /*
    Existing rows say `kata-clh` because that was the default, not because anything measured it.

    Rewritten to `none` only where the sandbox has a pod: those are the rows this control plane
    created, on this cluster, which has no Kata runtime class installed. A row with no pod never ran
    anything and its value is meaningless either way.
  */
  await sql`update sandbox set runtime_class = 'none' where pod_name is not null`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Back to a schema that cannot represent the truth, so the rows holding it have to go first.
  await sql`update sandbox set runtime_class = 'kata-clh' where runtime_class = 'none'`.execute(db)
  await sql`alter table sandbox drop constraint sandbox_runtime_class_check`.execute(db)
  await sql`alter table sandbox alter column runtime_class set default 'kata-clh'`.execute(db)
  await sql`
    alter table sandbox
      add constraint sandbox_runtime_class_check
      check (runtime_class in ('kata-fc', 'kata-clh'))
  `.execute(db)
}
