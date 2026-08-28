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

The rollout now has three independent gates. `acme_worker_enabled` stages capacity and scheduling,
`acme_handler_ownership_enabled` transfers privileged kinds only after that capacity exists, and
`acme_fallback_iam_enabled` retains the platform task's legacy authority until the transfer is
proven. OpenTofu validation and the exact-task handoff reject both isolated ownership without
capacity and platform ownership without fallback IAM. Disabling reverses the order. Mixed task
revisions temporarily overlap because `FOR UPDATE SKIP LOCKED` prevents a double claim; a total
ownership gap is the failure this finding records.
