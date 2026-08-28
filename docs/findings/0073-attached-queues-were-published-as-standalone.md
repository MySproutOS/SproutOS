# Attached queues were published as standalone

**Found:** 2026-08-28, while running the production Celery acceptance required by
`private_notes/ADDITIONS_1.md`.

A disposable Python project deployed successfully and its attached Valkey service became active,
but the binding the control plane published could never wake the project's Lambda. The service
creation route discarded the submitted `projectId` when it wrote the router's queue binding:

```json
{ "projectId": null, "functionArn": null }
```

That is the valid representation of a standalone Valkey service. The Rust dispatcher therefore did
exactly what it was designed to do and skipped invocation. The earlier Celery acceptance exercised
the producer, protocol, proxy ACL and bounded handler, but supplied a complete binding directly; it
did not prove the control plane ever created that binding.

## What now prevents it

Queue binding is a lifecycle rather than a one-time provision side effect:

- service creation always preserves attachment identity, while adding an executable target only
  when the durable live deployment and the router's live route agree;
- a successful production release moves every active attached Valkey binding to that exact live
  alias, preserving the one-time broker credential in place;
- rollback moves the bindings back with HTTP traffic, while preview releases never receive
  production queue work;
- attached service mutations take the same project lock as publication, and standalone mutations
  take a service-specific lock;
- service and project deletion replace the credential-bearing binding with a permanent,
  credential-free tombstone before provider teardown;
- target updates are atomic compare-and-sets and credential publication refuses a tombstone, so
  neither deployment nor a late rotation can resurrect deleted credentials;
- a transient missing target, exhausted balance, or Lambda invocation error rearms the exact wake
  after a bounded delay, pulling it ahead of any later BullMQ delayed-job alarm without overwriting
  a concurrent immediate enqueue. Celery and immediate BullMQ jobs no longer need another enqueue
  to recover.

The release integration test starts with an attached binding that has no function and proves
publication points it at the same alias as HTTP without changing its URI or project identity. The
queue lifecycle tests force the delete-then-late-rotation interleaving. Router tests drive real
Valkey wakes through success, absent-target, exhausted-credit, and failed-invocation paths.

Production acceptance remains incomplete until this change is deployed and the disposable Celery
producer receives its result through the public tenant credential.
