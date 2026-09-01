---
slug: connecting
title: Connect to services
summary: Use tenant-scoped credentials for Postgres, Valkey, search, and object storage.
audience: developer
category: Deploying
order: 1
---

## Tenant-scoped credentials

Provisioning or rotating Postgres, Valkey, or OpenSearch returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so those URIs cannot be revealed later.

Object storage is the exception. Its secret is derived rather than stored, so an authorized organization member can use **View credentials** again. Rotation still revokes the old access immediately at the storage proxy. See [Use object storage](/docs/object-storage) for SDK configuration and supported operations.

## Service variables

- Postgres uses `DATABASE_URL`.
- Valkey uses `VALKEY_URL` or `REDIS_URL`; BullMQ also uses the injected `BULLMQ_PREFIX`.
- OpenSearch uses `ELASTICSEARCH_URL` and automatically scopes index names.
- Object storage uses `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and path-style addressing.

All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns.
