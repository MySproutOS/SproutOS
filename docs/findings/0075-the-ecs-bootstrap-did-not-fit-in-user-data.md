# The ECS bootstrap did not fit in user data

**Found:** 2026-08-28, when the guarded ACME phase-A apply reached the shared ECS launch template.

## What looked true

The host bootstrap and seccomp profile were checked into the launch-template user data, OpenTofu
validated the configuration, and the bootstrap's own unit tests passed. The existing ECS fleet was
healthy because no launch-template version containing the larger payload had yet been created.

## What was actually true

EC2 limits decoded user data to 16,384 bytes. Embedding both files as base64 inside an uncompressed
shell script pushed the decoded launch-template payload over that limit. OpenTofu and the AWS
provider do not validate the service-side size constraint, so the first production apply failed at
`CreateLaunchTemplateVersion` with `InvalidUserData.Malformed` after unrelated phase-A resources
had already been applied.

## What stops this instance recurring

The launch template now sends gzip-compressed user data. Amazon Linux cloud-init detects the gzip
payload, expands it, and then executes the same integrity-checked script; the bootstrap and profile
contents and their fail-closed behavior are unchanged. The guarded rollout still requires a newly
saved and reviewed plan after any partial apply, so an apply failure cannot be retried against stale
state.
