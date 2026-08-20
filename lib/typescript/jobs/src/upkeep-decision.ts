/**
 * What a comparison against upstream means, as a decision nobody has to make twice.
 *
 * Separated from the GitHub call on purpose. The call is I/O that needs an installation token and
 * a live repository; the decision is a handful of rules about money and merge conflicts, and those
 * are worth pinning down in tests that do not need either.
 */

/** The shape of GitHub's `compare` response that actually matters here. */
export type UpstreamComparison = {
  /** How many commits the fork is missing from upstream. */
  behindBy: number
  /** How many commits the fork has that upstream does not. */
  aheadBy: number
  /** GitHub's own verdict: "identical" | "ahead" | "behind" | "diverged". */
  status: string
  upstreamSha: string
  forkSha: string
  /** Files upstream touched. Empty when GitHub truncates a very large comparison. */
  changedFiles: number
}

export type UpkeepAction =
  | { action: "skip"; outcome: "up_to_date"; reason: string }
  | { action: "fast_forward"; mergeType: "fast_forward" }
  | { action: "reconcile"; mergeType: "merge"; reason: string }

/**
 * Decide what to do with a fork, given how it compares to upstream.
 *
 * Three rules, and the ordering between them is the whole point:
 *
 * 1. **Nothing to do costs nothing.** `identical` and `ahead` mean upstream has nothing the fork
 *    is missing. Running an agent to discover that would bill a customer for a no-op, nightly.
 * 2. **A fork with no local commits fast-forwards.** No agent, no tokens — the merge is mechanical
 *    and there is nothing to reconcile. This is the common case for someone who forked an app and
 *    only changed configuration, and paying a model to perform a fast-forward would be absurd.
 * 3. **Everything else is a reconciliation**, which is the expensive path and the only one that
 *    spends tokens.
 */
export function decideUpkeepAction(comparison: UpstreamComparison): UpkeepAction {
  if (comparison.behindBy === 0) {
    return {
      action: "skip",
      outcome: "up_to_date",
      reason: comparison.aheadBy > 0 ? "ahead of upstream" : "identical to upstream",
    }
  }

  if (comparison.aheadBy === 0) {
    // Nothing local to preserve, so there is nothing for a model to think about.
    return { action: "fast_forward", mergeType: "fast_forward" }
  }

  return {
    action: "reconcile",
    mergeType: "merge",
    reason: `${comparison.behindBy} commit(s) behind and ${comparison.aheadBy} ahead`,
  }
}

/** The branch an upkeep run opens its pull request from. One per upstream commit, so a re-run of
 *  the same comparison reuses the branch instead of opening a second pull request for one change. */
export function upkeepBranchName(upstreamSha: string): string {
  return `sproutos/upkeep-${upstreamSha.slice(0, 12)}`
}
