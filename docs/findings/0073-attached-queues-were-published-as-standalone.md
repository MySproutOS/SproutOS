# Attached queues were published as standalone

**Found:** 2026-08-28, while running the production Celery acceptance required by
`private_notes/ADDITIONS_1.md`.

A disposable Python project deployed successfully and its attached Valkey service accepted real
Celery traffic, but publishing a task could never wake the project's Lambda. The service creation
route discarded the submitted `projectId` when it wrote the router's queue binding:

```json
{ "projectId": null, "functionArn": null }
```

That is the valid representation of a standalone Valkey service. The Rust dispatcher therefore did
exactly what it was designed to do and skipped invocation. The earlier Celery acceptance exercised
the producer, protocol, proxy ACL and bounded handler, but supplied a complete binding directly; it
did not prove the control plane ever created that binding.

## What now prevents it

Queue binding is a lifecycle rather than a one-time provision side effect:

- service creation preserves the project target only when the durable live deployment and the
  router's live route agree;
- a successful production release moves every active attached Valkey binding to that exact live
  alias, preserving the one-time broker credential in place;
- rollback moves the bindings back with HTTP traffic, while preview releases never receive
  production queue work;
- service and project deletion withdraw the credential-bearing binding before provider teardown;
- the update is an atomic compare-and-set, so deployment cannot resurrect a credential concurrently
  rotated or deleted by another request.

The release integration test starts with a real standalone-shaped binding and proves publication
attaches it to the same alias as HTTP without changing its URI. The queue lifecycle tests prove
target removal and deletion races. The router test drives a real Valkey wake through one dispatcher
iteration and records the exact alias it would invoke.

Production acceptance remains incomplete until this change is deployed and the disposable Celery
producer receives its result through the public tenant credential.
