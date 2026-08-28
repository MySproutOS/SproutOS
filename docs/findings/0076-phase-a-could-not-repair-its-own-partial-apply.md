# Phase A could not repair its own partial apply

**Found:** 2026-08-28, after the ACME foundation apply failed at the ECS launch template.

## What looked true

The rollout gate correctly rejected unchanged phases, and the apply wrapper correctly required the
live estate to implement its saved plan's `before` phase. After replacing the oversized user data,
a fresh plan could therefore be reviewed and retried through the same guarded path.

## What was actually true

The failed `NONE -> A` apply had already written phase-A flags and most foundation resources to
state, but it had not created `sproutos-acme-worker`. The fresh plan was necessarily A -> A. The
ordinary plan checker rejected A -> A, while the ordinary phase-A verifier rejected the missing
service before apply. Bypassing either check would also have bypassed the controls that made the
original rollout auditable.

The serving web revision was still safe: two stable tasks used the chosen immutable image,
`ACME_JOBS_ENABLED` was `0`, the absent ownership variable defaulted to false in that exact runtime,
and fallback ACME IAM remained attached. All four tenant-edge target groups were PPv2-ready but
empty and unassociated. That narrow state was repairable; a generic unchanged-phase transition was
not.

## What stops this instance recurring

`bin/apply-acme-worker-partial-a-repair.sh` is a separate, one-purpose transition. Its plan checker
requires unchanged phase-A outputs and the exact four observed actions: create the missing service,
replace both task definitions, and update the ECS launch template. It pins an immutable Git-SHA
image and compares the complete task, service, and launch-template provider objects, allowing only
the reviewed image, metadata-IPv6, and exact source-rendered compressed user-data deltas. This
preserves explicit post-repair `0/0/true` gates, zero isolated desired capacity, all container
secrets and privilege fields, the service's placement/deployment/tagging contract, dedicated
isolated roles and account-key reference, IMDS enforcement, and EC2's 16 KiB user-data limit.

Before apply, the repair verifier proves the only permitted partial live shape, including the
fallback attachment and absent isolated tasks. It normalizes only a missing ownership environment
entry to the runtime's false default and the two diagnosed missing Android bucket entries to their
exact reviewed values and indices, then compares the entire live web task contract with the reviewed
OpenTofu base. An automatic deploy changing only the immutable image remains valid, while any other
contract difference fails. Cluster-wide RUNNING and PENDING enumeration rejects service-owned or
detached ACME-family tasks without querying the deliberately missing service. The existing
target-group verifier proves all four edge groups remain offline. It also compares the live
application-policy semantics with the
reviewed policy and the live launch-template identity/latest/default versions with the plan's
`before` state. The wrapper protects the reviewed plan bytes, applies that copy, then uses the
ordinary task handoff and full phase-A verifier. The normal adjacent transition guard still rejects
A -> A, so this recovery cannot become a routine escape hatch.
