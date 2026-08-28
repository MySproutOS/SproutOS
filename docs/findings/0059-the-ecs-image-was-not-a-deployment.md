# 0059: The ECS image was not a deployment

## What was wrong

The Deploy workflow built and pushed an immutable website image, but nothing registered that image
as an ECS task-definition revision or updated `sproutos-web`. Every push could report a successful
image job while the service kept running the revision OpenTofu had registered earlier.

The image also omitted `migrate.mjs`, its migration files, the seed runner/files and the ClickHouse
schema runner. The only production migration path executed those programs over SSM on the idle
legacy website Auto Scaling group. Turning the legacy group off therefore also turned migrations
off; leaving it on let a previous release migrate for a new container release.

## Why the existing checks passed

Building and pushing proves an artifact exists, not that a scheduler references it. OpenTofu's ECS
service intentionally ignores task-definition drift because deployment owns the image revision, but
deployment had no corresponding update step. Neither side owned the handoff and both were green.

The legacy tarball packaging tests proved the migrator was in that tarball. They said nothing about
the Dockerfile, which was a different artifact assembled by a different job.

## What stops it recurring

- The image contains the deploy migrator, scanned migration/seed files and ClickHouse schema runner.
- `deploy-ecs-web.sh` derives new service and migration definitions from the live task contract,
  replaces every container image with the same Git-SHA tag, and runs the isolated migration task
  before `UpdateService`.
- A failed migration test asserts that no service update occurs. The success test inspects both
  registered JSON documents and proves all service containers use the immutable image.
- `ECS_WEB_ENABLED` removes website from all three legacy phases while leaving router blue/green
  intact. A workflow invariant test covers each phase and the combined-release dependency gate.
- ECS's deployment circuit breaker rolls a failed service revision back. The runbook documents both
  an earlier-image rollback and a platform rollback to the legacy blue group.
