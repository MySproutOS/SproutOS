# 0061: The immutable task used a different ClickHouse database

## What was wrong

The legacy production release and the OVH ClickHouse server use the database `sproutos`. Both the
API and worker containers in the new ECS task definition instead set `CLICKHOUSE_DATABASE` to
`observability`.

The first immutable ECS migration therefore completed its Postgres migrations and seeds, reached
the ClickHouse schema step, and failed with `UNKNOWN_DATABASE` before any service update or traffic
change. The failure was safe because deployment orders migration before `UpdateService`, but it
made the immutable release path unusable.

## Why the existing checks passed

`tofu validate` checks references and types; it cannot know which databases exist on an external
ClickHouse server. Local and CI ClickHouse intentionally create `observability`, so their runtime
tests also proved only the test environment's contract. The legacy EC2 template held the correct
production value, but no check compared it with the ECS task definition.

## What stops it recurring

- The ECS API and worker reference one `local.ecs_clickhouse_database` value, set to the existing
  production database `sproutos`.
- `bin/clickhouse-database.test.sh` asserts that both containers use that local, rejects a new
  hard-coded ECS value, and requires the immutable and legacy production launch paths to agree.
- `deploy-ecs-web.sh` accepts an exact OpenTofu-registered base revision, verifies that it is active
  and belongs to the serving task family, then carries its corrected contract through the existing
  migration-before-service-update gate. The runbook documents the read-and-verify handoff.
- CI runs that contract alongside the other deployment-script checks.

The test database remains named `observability`; changing it would hide the distinction between a
local test fixture and the external production database rather than enforce the production
contract.
