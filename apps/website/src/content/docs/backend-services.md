---
slug: backend-services
title: Backend services
summary: Create Postgres, Valkey, OpenSearch, or object storage as a standalone resource or attach it to a project.
audience: user
category: Backend services
order: 10
---

SproutOS provides four managed backend service kinds: Postgres, Valkey, OpenSearch, and S3-compatible
object storage. Open **Databases** to create and manage all four; the navigation name covers more
than relational databases.

## Attached and standalone services

When creating a service, choose a project or leave **Project** set to **Standalone**.

{% image src="/docs/create-service.png" alt="New database dialog with Postgres selected and Project set to Standalone" width=470 height=390 caption="Choose a service kind and either attach it to a project or leave it at the organization level." /%}

- **Attached** means SproutOS associates the service with one deployable project and writes the
  connection settings into that project's encrypted environment.
- **Standalone** means the service belongs to the organization without an automatic project
  association. It remains a SproutOS-managed service. Copy its connection value into each
  authorized project yourself.

Choose standalone when several projects need the same data store, when a database is operated
independently from an application release, or when OAuth users receive their own service. Choose
attached for the common one-application, one-service case.

## Pick the service by workload

- [Postgres](/docs/postgres) stores relational application data and supports disposable branches
  for safe schema work.
- [Valkey](/docs/valkey) provides cache and queue primitives; BullMQ projects also receive a tenant
  prefix.
- [OpenSearch](/docs/opensearch) provides tenant-scoped search indexes.
- [Object storage](/docs/object-storage) stores mutable files through an S3-compatible API. It is
  private by default, supports presigned browser transfers and optional anonymous object reads, and
  uses multipart uploads when an individual request would exceed 64 MiB.

Services are independent resources. Deploying application code does not recreate them, and rolling
back a deployment does not roll back their data.

## Capture and rotate credentials safely

Postgres, Valkey, and OpenSearch connection URIs are displayed only when created or rotated.
SproutOS stores a verifier, not a recoverable plaintext copy. Save the value directly into an
encrypted environment target and do not put it in source control, logs, screenshots, or shell
history.

If the value is lost, rotate it. Rotation revokes the previous credential, so update every
consumer together. Object storage is the exception: its derived credential can be viewed again,
although rotation still invalidates the old one.

## Know the sandbox boundary

Hosted Agent sandboxes intentionally do not receive production runtime secrets. When an agent needs
a database, it requests a disposable Postgres branch with a scoped action token. This prevents a
code-editing session from silently gaining access to production data. See [Agent sandboxes](/docs/agent-sandboxes).
