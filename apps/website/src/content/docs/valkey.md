---
slug: valkey
title: Use Valkey and queues
summary: Connect caches and BullMQ workers through the tenant proxy without leaving idle invocations running.
audience: user
category: Backend services
order: 12
---

Valkey is the Redis-compatible cache and queue service. Create it under **Databases**, then attach it
to a project or keep it standalone.

## Use the injected variables

An attached service supplies `VALKEY_URL` and the compatible alias `REDIS_URL`. BullMQ deployments
also use `BULLMQ_PREFIX` so queue keys remain inside the tenant namespace. Configure the client from
these variables instead of hard-coding a host, password, database number, or key prefix.

The endpoint is a SproutOS tenant proxy. Use the returned URI as a single credential and rotate it
if it is lost or exposed; the old credential stops working after rotation.

## Build queue workers for invocation, not residency

Repository workflows are invoked when work is available. Process the delivered batch, close or
release open resources, and return. Do not keep a subscribe command, blocking read, timer, or
infinite worker loop alive inside an invocation; idle runtime still consumes compute.

For queue framework choices and triggers, see [Repository workflows](/docs/repository-workflows)
and [Background workers](/docs/background-workers).
