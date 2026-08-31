---
slug: limits
title: Limits
summary: Function duration, request size, memory, and concurrency.
audience: user
category: Billing & limits
order: 3
---

## Runtime

An invocation runs for at most 15 minutes. Split longer jobs and enqueue the remainder. Memory is configurable from 128 MB to 10 GB and CPU grows with memory.

## Payloads and builds

Request and response bodies are limited to 6 MB; use object storage for larger data. The deploy tooling refuses application bundles over 200 MB uncompressed, ahead of Lambda's 250 MB hard limit.

## Concurrency

Invocations may run concurrently in isolated environments. Pools created at module scope may be reused by a warm instance; never store a user's session or request state there.
