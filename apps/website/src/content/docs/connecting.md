---
slug: connecting
title: Connect to services
summary: Use tenant-scoped credentials for Postgres, Valkey, search, and object storage.
audience: developer
category: Deploying
order: 13
---

## Tenant-scoped credentials

Provisioning or rotating Postgres, Valkey, or OpenSearch returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so those URIs cannot be revealed later.

Object storage is the exception. Its secret is derived rather than stored, so an authorized organization member can use **View credentials** again. An application can mint presigned URLs for supported S3 operations without handing that secret to a browser. Presigned URLs may last at most seven days, and rotation still revokes both ordinary credential use and unexpired URLs immediately at the storage proxy. See [Use object storage](/docs/object-storage) for SDK configuration, public-read controls, limits, and unsupported operations.

## Service variables

- Postgres uses `DATABASE_URL`.
- Valkey uses `VALKEY_URL` or `REDIS_URL`; BullMQ also uses the injected `BULLMQ_PREFIX`.
- OpenSearch uses `ELASTICSEARCH_URL` and automatically scopes index names.
- Object storage uses `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and path-style addressing.

All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function
returns. For creation, attachment, standalone ownership, and rotation, start with [Backend
services](/docs/backend-services).
