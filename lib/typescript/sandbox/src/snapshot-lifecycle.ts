export const MANAGED_SNAPSHOT_PREFIX = "sproutos-agent-"
export const SNAPSHOT_DELETE_TIMEOUT_MS = 60_000

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

/** Snapshot deletion has no SDK wait flag, so require a provider read to confirm it is gone. */
export async function deleteSnapshotAndWait(
  remove: () => Promise<void>,
  exists: () => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void> = async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  },
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + SNAPSHOT_DELETE_TIMEOUT_MS
  await remove()
  while (now() < deadline) {
    if (!(await exists())) return
    await sleep(1_000)
  }
  throw new Error("Daytona did not confirm snapshot deletion within one minute")
}
