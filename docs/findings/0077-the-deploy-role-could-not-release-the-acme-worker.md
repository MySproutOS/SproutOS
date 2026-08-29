# The deploy role could not release the ACME worker

**Found:** 2026-08-28, on the first automatic release after the isolated ACME service existed.

## What looked true

Phase A had created `sproutos-acme-worker` at desired count zero, and the release script already
registered an immutable ACME task revision after the public web revision became healthy. The script
test exercised that complete sequence and passed.

## What was actually true

The GitHub deploy role could register web task definitions only because it could pass the public
task role and shared ECS execution role. Its policy did not allow `iam:PassRole` for
`sproutos-acme-task`, nor did its `ecs:UpdateService` grant name the isolated service.

The first affected release successfully migrated, started web revision 61, and made both web target
groups healthy. At `RegisterTaskDefinition` for the isolated worker, AWS denied `iam:PassRole` on
`sproutos-acme-task`. The release script correctly treated a split-image deployment as failed and
restored web revision 60. This was not a container-health, DNS, TLS, or tenant-edge traffic failure.

The script test's AWS stub accepted every call. It proved call order and rollback behavior, but not
that the production role authorized the calls the script had gained.

## What stops this instance recurring

The deploy role's mutable ECS access now names exactly the public web service and isolated ACME
service. Its PassRole grant names exactly the public task role, isolated ACME task role, and their
shared execution role, still conditioned on `ecs-tasks.amazonaws.com`. Describe and task-definition
registration retain the resource scope AWS supports; migration execution remains limited to the
web-migration family and platform cluster.

`bin/deploy-role-policy.test.sh` inventories every ECS command used by the isolated-worker release,
then asserts the complete policy surface. It also rejects a wildcard or any unrelated service or
role in the two mutating grants. The deployment behavior test and authorization-contract test now
fail independently: a new API call needs both a stubbed behavior and an explicit least-privilege
policy decision.
