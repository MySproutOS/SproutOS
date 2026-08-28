# Celery was documented but could not start

**Found:** 2026-08-28, by running a real Celery 5.5.3 producer and worker through the complete
Valkey proxy instead of sending Redis commands that looked like Celery.

`private_notes/ADDITIONS_1.md` requires a Celery workflow to be tested from a GitHub repository.
The broader launch reporting in `private_notes/app_store_upload.md` also requires live edges to be
recorded individually and forbids reporting mocks as live evidence. This check is the deterministic
repository-to-proxy edge; production dispatch and Lambda execution remain separate live edges.

## What was wrong

The proxy allowed `EVALSHA`, and its tests exercised Celery's plain-list queue layout with raw RESP.
That looked like script and Celery support. A fresh Celery worker does something the approximation
never did:

1. redis-py tries the worker's visibility-timeout mutex with `EVALSHA`;
2. a fresh server correctly replies `NOSCRIPT`;
3. redis-py sends `SCRIPT LOAD` before retrying; and
4. the proxy refused the entire `SCRIPT` command family as administrative.

The worker terminated during broker startup with `ResponseError('unknown or disallowed command')`.
No task could be consumed. Production documentation nevertheless said Celery worked without a
prefix, and a unit test only proved that a key literally named `celery` could be namespaced.

## Why the fix is narrow

Granting all of `SCRIPT` is unsafe on a shared server: `SCRIPT FLUSH` invalidates every tenant's
script cache and `SCRIPT KILL` can interrupt somebody else's work. The proxy now accepts exactly
`SCRIPT LOAD <source>`, and the upstream ACL applies `+SCRIPT|LOAD` after its broad `-SCRIPT`
denial. Loading does not execute the source. Later execution still goes through `EVALSHA`; the
tenant ACL enforces the tenant key pattern even for keys a script constructs from arguments.

`SCRIPT FLUSH`, `SCRIPT KILL`, `SCRIPT EXISTS`, malformed loads, and every other subcommand remain
refused. The Rust and TypeScript ACL policies share the same versioned fixture, so a provisioned
credential and a reconciled credential cannot disagree.

## What proves it now

The Rust integration suite starts the real proxy against Postgres and Valkey, provisions a tenant
credential, then launches the pinned Python repository fixture as a normal Celery producer and
worker. It also publishes a second task, invokes the repository's bounded `queue.drain` Lambda
handler, and reads the result through Celery. It asserts both results are `42` and independently
reads the router's master wake set to prove that the live Celery publishes also notified dispatch.
CI installs every Python dependency from a hash-locked requirements file; Celery missing in CI is a
failure, never a skip.

This does **not** claim the final production edge has run. That requires a deployed Python workflow
project with a Valkey service, publishing through its public tenant credential, the router invoking
the project's Lambda with `sproutos.kind = queue.drain`, and an observable task side effect. Until
that disposable project exists and the edge is recorded, production Celery acceptance remains
incomplete rather than inferred from this test.
