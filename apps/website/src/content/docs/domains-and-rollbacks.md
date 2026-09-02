---
slug: domains-and-rollbacks
title: Domains and rollbacks
summary: Verify a generated hostname, activate a custom domain, and move production traffic to a known ready release.
audience: developer
category: Deploying
order: 15
---

Every website or API project receives a generated SproutOS hostname. Workflow runtime projects do
not, because queue and schedule triggers invoke them rather than browser traffic.

## Verify before adding a domain

Deploy the project and test the generated hostname first. This separates application and runtime
problems from DNS and certificate problems. Confirm the response in **Logs**, including the expected
project and source release, before changing DNS.

Add a custom hostname from the project's domain settings and create the exact DNS record SproutOS
shows. The domain becomes active only after ownership, routing, and certificate checks succeed.
Avoid putting a proxy or redirect in front of the validation record until activation completes.

For a repository group, the primary child's active custom domain becomes the group's customer-facing
domain. Changing the primary child changes the destination; it does not transfer that child's
services or environment.

## Roll back traffic, not data

A rollback points the project's live route at an earlier **ready production** deployment. It does
not rebuild or upload the artifact. Preview, failed, queued, and never-served releases are not valid
rollback targets.

Static and serverless serving modes cannot be interchanged by rollback. Deploy a deliberate
conversion instead of trying to point a static project at a server runtime or the reverse.

Rollback changes application traffic only. It does not reverse database migrations, restore
Postgres rows, undo queue jobs, or restore object-storage files. Before a schema-changing release,
use backward-compatible migrations so both the old and new application versions can operate during
the rollback window.

After rollback, exercise the generated and custom hostnames and inspect a matching request in logs.
If the data contract is no longer compatible with the older code, roll forward with a corrective
release rather than repeatedly moving traffic.
