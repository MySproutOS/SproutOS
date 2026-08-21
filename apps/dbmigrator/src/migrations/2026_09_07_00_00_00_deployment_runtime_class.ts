import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * The other table that names a runtime class, and the one that was left behind.
 *
 * `sandbox.runtime_class` had this exact problem and was fixed twice — once to drop a `kata-clh`
 * default that claimed a VM boundary no pod had, and again to replace an enum that rejected
 * `gvisor`. `deployment.runtime_class` is the sibling column, it kept `kata-fc` as its default, and
 * nothing noticed because until this week no deployment had ever reached a cluster.
 *
 * The consequence, once one did: the `kata-fc` RuntimeClass carries
 * `nodeSelector: katacontainers.io/kata-runtime=true` in its `scheduling` block, Kubernetes merges
 * that into every pod that names the class, and no node in a GKE Sandbox cluster carries that
 * label. Every tenant revision was
 *
 *     0/3 nodes are available: 1 node(s) had untolerated taint(s),
 *     2 node(s) didn't match Pod's node affinity/selector
 *
 * — a scheduling message that says nothing about runtime classes, for a pod nobody asked to be a VM.
 *
 * Nullable with no default, exactly like `sandbox.runtime_class`. A deployment names a runtime class
 * only where the cluster has one; absent means the pod is scheduled normally, which is what a
 * managed cluster without `kata-deploy` can actually honour. What isolates a tenant there is the
 * namespace, its NetworkPolicy and — where the node pool provides it — gVisor.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployment alter column runtime_class drop default`.execute(db)
  await sql`alter table deployment alter column runtime_class drop not null`.execute(db)

  /*
    Existing rows are cleared, not left.

    Every one names `kata-fc` because that was the default, not because anyone chose it, and each is
    a revision that cannot schedule. Leaving them would keep the platform's own history unusable to
    prove nothing was decided about it.
  */
  await sql`update deployment set runtime_class = null where runtime_class = 'kata-fc'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update deployment set runtime_class = 'kata-fc' where runtime_class is null`.execute(db)
  await sql`alter table deployment alter column runtime_class set not null`.execute(db)
  await sql`alter table deployment alter column runtime_class set default 'kata-fc'`.execute(db)
}
