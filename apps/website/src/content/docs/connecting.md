---
slug: connecting
title: Connect to services
summary: Use one-time, tenant-scoped credentials for Postgres, Valkey, search, and storage.
audience: developer
category: Deploying
order: 1
---

## One-time credentials

Provisioning or rotating a service returns its connection URI once. Put it in the project's encrypted environment variables. SproutOS stores a verifier, not a recoverable copy, so the URI cannot be revealed later.

## Service variables

- Postgres uses `DATABASE_URL`.
- Valkey uses `VALKEY_URL` or `REDIS_URL`; BullMQ also uses the injected `BULLMQ_PREFIX`.
- OpenSearch uses `ELASTICSEARCH_URL` and automatically scopes index names.
- Object storage uses the injected `S3_*` values and path-style addressing.

All endpoints pass through tenant-enforcing SproutOS proxies. Close connections before a function returns.
