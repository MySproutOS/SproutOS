# The worker could not see the deployment

**Found:** 2026-08-28, by following a production `deploy.release` row that remained queued while
both platform worker tasks were healthy.

## What looked true

The API accepted the artifact, inserted the background job, and the platform workers continued to
run other kinds. The queue row had no error or exhausted attempt because nothing had tried it.

## What was actually true

`claim` filters rows to the keys in a worker's handler map. Deployment, teardown, and certificate
kinds had moved exclusively into `ACME_HANDLERS`, but the isolated ACME ECS service was deliberately
still at desired count zero during its staged rollout. Platform workers received
`ACME_JOBS_ENABLED=0` yet selected only `PLATFORM_HANDLERS`, so `deploy.release` was invisible to
every live process. An invisible job stays `queued` forever rather than failing visibly.

The registry test proved that the union of both static maps covered every declared kind. It did not
prove that at least one profile carrying each map was actually running for every rollout state.

## What stops this instance recurring

While isolation is absent or explicitly disabled, a platform worker selects the union of platform
and privileged handlers. Once isolation is enabled, the platform profile relinquishes privileged
kinds and the ACME profile retains its exact map. Tests cover both live-profile configurations, a
real queued `deploy.release` claim, and malformed flag values.

This hotfix relies on the legacy production task role still having the authority those deployment
handlers require. It does **not** make the current single flag an atomic rollout protocol. Before
applying the isolated-worker infrastructure, a separate change must stage capacity first, transfer
handler ownership second, and remove fallback IAM last; disabling must reverse that order. Mixed
task revisions should temporarily overlap because `FOR UPDATE SKIP LOCKED` prevents a double claim.
A total ownership gap is the failure this finding records.
