export const MANAGED_SNAPSHOT_PREFIX = "sproutos-agent-"

/**
 * Managed base snapshots that no deployment is allowed to create from anymore.
 *
 * The configured snapshot is retained even if its `lastUsedAt` is old: age cannot prove that a
 * production secret stopped naming it. System snapshots and another application's snapshots are
 * outside this repository's authority and are never selected.
 */
export function obsoleteManagedSnapshots<T extends { id: string; name: string }>(
  snapshots: readonly T[],
  configuredSnapshot: string,
  liveSandboxSnapshots: ReadonlySet<string> = new Set(),
): T[] {
  return snapshots.filter(
    (snapshot) =>
      snapshot.name.startsWith(MANAGED_SNAPSHOT_PREFIX) &&
      snapshot.name !== configuredSnapshot &&
      snapshot.id !== configuredSnapshot &&
      !liveSandboxSnapshots.has(snapshot.name) &&
      !liveSandboxSnapshots.has(snapshot.id),
  )
}
