---
slug: limits
title: Limits
summary: Function duration, request size, memory, and concurrency.
audience: user
category: Billing & limits
order: 51
---

## Runtime

An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory.

## Payloads and builds

Application request and response bodies routed through a deployed function are limited to 6 MB. Object-storage traffic uses the separate S3-compatible storage endpoint and has a 64 MiB limit per request; use an SDK multipart upload for larger objects and keep each part at or below that limit. Presigned URLs can send browser uploads and downloads directly to that endpoint without passing the bytes through your application.

The deploy tooling refuses application bundles over 200 MB uncompressed, ahead of Lambda's 250 MB hard limit.

## Concurrency

Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.
