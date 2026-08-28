# The template service retry refused to retry

## What was wrong

Catalogue installation persisted a `project_template_service` row before asking the service driver
to provision its backend. That was the correct ordering: the provider mutation had a durable
SproutOS identity before it began. But if the worker stopped after the driver returned and before
the bindings and `provisioned_at` marker were durable, every retry treated that same row as an
operator-only recovery case and threw `TemplateServiceRecoveryRequiredError`.

The safe identity existed, and the provider-side service existed, but the worker refused to use
either. Creating another row was correctly forbidden; making the original row terminal was not.

## Why the checks missed it

Lifecycle tests made service provisioning either finish or reject as one indivisible promise. They
did not stop the sequence after provider success, after one binding write, or while a second worker
was waiting to retry. The failure therefore looked like a defensive duplicate-credential guard
rather than an install that could never make progress again.

## What stops it coming back

Recovery now uses the persisted `backend_service_id`; it never allocates a replacement. The driver
must first prove that exact service has durable provider state. Object-storage credentials can be
reconstructed from their stored version and root key. Credentials stored as one-way hashes are
rotated, leaving the prior credential as a revoked audit row, and all declared bindings are then
upserted before `provisioned_at` and `backend_service.status = active` commit together.

A project advisory lock covers the read, provider recovery, binding writes, and final marker. A
concurrent retry therefore observes the completed marker instead of rotating the credential that
the first worker just wrote. If the driver cannot prove the persisted service exists, recovery
still fails closed and never calls `provision` again.

Deterministic tests stop after the provider result, fail a first binding pass, retry a failed
provider read, and run two attempts against the same blocked provision. They assert one provider
provision, one eventual credential, and a completed marker.
