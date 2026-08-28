# The template service retry refused to retry

## What was wrong

Catalogue installation persisted a `project_template_service` row before asking the service driver
to provision its backend. That was the correct ordering: the provider mutation had a durable
SproutOS identity before it began. But if the worker stopped after the provider mutation, including
when the provider applied a request and its response never reached the driver, the local mapping
could be absent and every retry treated that same row as an operator-only recovery case.

The safe identity existed, and the provider-side service could exist, but the worker refused to use
either. Creating another row was correctly forbidden; making the original row terminal was not.

## Why the checks missed it

Lifecycle tests made service provisioning either finish or reject as one indivisible promise. They
did not stop the sequence after an external mutation but before its response, after one binding
write, or while a second worker was waiting to retry. The failure therefore looked like a defensive
duplicate-credential guard rather than an install that could never make progress again.

## What stops it coming back

Recovery now uses the persisted `backend_service_id`; it never allocates a replacement and the
generic catalogue layer never replays `provision`. Each driver owns adoption of its provider
identity. Neon searches for the exact full service-id name (and the prior exact short-name format),
requires one matching project, primary branch, database, and owner role, then stores the Neon project
and branch ids. Shared Postgres reads the exact UUID-derived role and database, checks ownership,
resets the otherwise-lost role secret, and stores the instance/branch/role mapping. Legacy S3 heads
the exact UUID-derived bucket and reapplies its idempotent CORS configuration without replaying
`CreateBucket`. Those durable mappings are the same rows billing and teardown already enumerate.

If an exact provider resource is absent or ambiguous, recovery fails closed. It does not infer that
a non-idempotent create is safe merely because a provider list has not returned the resource.
Object-storage credentials can be reconstructed from their stored version and root key. Credentials
stored as one-way hashes are rotated, leaving the prior credential as a revoked audit row, and all
declared bindings are then upserted before `provisioned_at` and `backend_service.status = active`
commit together.

A project advisory lock covers the read, provider recovery, binding writes, and final marker. The
background-job `keepAlive` callback is invoked on every blocked lock poll and periodically throughout
the acquired work, so the queue's five-minute lease remains owned during both the lock's thirty-minute
wait and a slow provider operation. A concurrent retry therefore observes the completed marker
instead of rotating the credential that the first worker just wrote. If the driver cannot prove the
persisted service exists, recovery still fails closed and never calls `provision` again.

The background queue and `project_job` also agree about retryability. Before the final queue attempt,
a thrown provision returns the project job and its running step to `queued`/`pending` and leaves the
template in `provisioning`; the queue's backoff can then enter the same recovery path. Only an
exhausted background attempt records terminal project, template, and step failure.

Deterministic tests model Neon, shared-Postgres, and legacy-S3 mutations already existing before any
local evidence, stop after a provider result, fail a first binding pass, retry a failed provider
read, and run two attempts against the same blocked provision. The background-worker test executes
the ordinary queue failure/backoff/claim path and proves its second attempt reaches reconciliation
without another provider resource. Deterministic lock tests count heartbeats both while waiting and
while acquired work remains blocked. The assertions cover one provider provision, one eventual
credential, exact provider identities, a completed marker, and continued lease ownership.
