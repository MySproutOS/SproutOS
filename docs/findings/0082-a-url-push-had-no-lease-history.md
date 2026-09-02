# 0082 — A URL push had no lease history

Found by creating the private Memos and Umami catalogue-acceptance projects in production. Both
workers copied the pinned upstream snapshot, applied the signed plugin, and then exhausted all
three provisioning attempts with `HEAD -> main (stale info)`.

The checkout cloned `origin/main`, but the commit helper pushed to a raw authenticated HTTPS URL.
Bare `--force-with-lease` derives its expected value from tracking information associated with the
push destination. The raw URL was not the configured `origin`, so Git treated the already-existing
`main` branch as unexpected even though the checkout had cloned that exact head. This affected
catalogue installation and any other control-plane commit pushed back to the cloned branch.

## Guard

The helper now passes an explicit lease for the exact destination ref and the observed
`refs/remotes/origin/<branch>` SHA. If the shallow, single-branch checkout has no tracking ref for a
different destination branch, the explicit empty lease requires that branch not to exist. A
hermetic real-Git test creates a bare origin and clone, then asserts both the observed-head and
unobserved-branch lease forms.

Production acceptance remains the decisive regression check: retry the same project jobs so the
workers resume the already-created repositories, and require the signed-template commit to land
before treating provisioning as repaired.
