---
slug: limits
title: Limits
summary: Function duration, request size, memory, and concurrency.
---

## Runtime

An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory.

## Payloads and builds

Request and response bodies are limited to 6 MB; use object storage for larger data. Deployable application bundles are limited to 250 MB uncompressed and are rejected before upload when over the build threshold.

## Concurrency

Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.
