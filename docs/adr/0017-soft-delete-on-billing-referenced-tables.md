# 0017. Soft delete (`deleted_at`) on anything `usage_event` references

- Status: Accepted
- Date: 2026-08-20

## Context

Three areas designed three different delete semantics for the same object graph.

The projects notes give `project` a `deleted_at` soft delete and make `repository` an
`ON DELETE RESTRICT` parent. The compute notes declare `deployment.project_id FK project(id)
**on delete cascade**`. The data-plane notes declare `database_instance.project_id FK projects
**ON DELETE CASCADE**` _and_ give the table its own `deleted_at`.

Mixed in one schema, these are worse than either alone. A hard `DELETE FROM project` cascades into
deployments and database instances, and takes `usage_event.project_id` with it — destroying the
billing history that justifies charges already made. The critique states it plainly: a hard delete
silently destroys billing history.

The same graph has an inverse defect at the top. `organization.owner_user_id FK user ON DELETE
RESTRICT` combined with `organization_member.user_id ON DELETE CASCADE` makes user deletion
structurally impossible — you cannot remove the row, and you cannot cascade past it.

## Decision

Anything `usage_event` references — `organization` and `project` — is **soft-deleted** via a
nullable `deleted_at timestamptz`. Their inbound FKs from billing tables are `ON DELETE RESTRICT`.
No cascade may reach a table the ledger points at.

Concretely:

- `project.deleted_at`, `organization.deleted_at`.
- `usage_event.organization_id` / `usage_event.project_id`: `ON DELETE RESTRICT`.
- `deployment.project_id` and `database_instance.project_id` change from `CASCADE` to `RESTRICT`;
  those tables get their own `deleted_at`.
- Deletion is a _state change plus a teardown job_: soft-delete the row, then a background job
  tears down external resources (Knative services, database branches, ECR images, search indexes)
  and marks the child rows deleted.
- Every DAO `fetch*` function filters `deleted_at IS NULL` by default. Uniqueness constraints that
  should permit re-use of a name after deletion become partial unique indexes
  `WHERE deleted_at IS NULL`.

## Consequences

- Billing history survives project and org deletion, which is the point. A statement for last month
  still resolves its line items to named projects.
- `organization.owner_user_id` becomes `ON DELETE RESTRICT` against a _soft-deletable_ user, and user
  deletion is a phase-18 workflow — reassign or delete owned orgs first, then anonymize — rather than
  a `DELETE` that cannot run. The structural impossibility is resolved in the init migration, not
  discovered later.
- Genuine erasure (GDPR) is a separate, deliberate path: anonymize the personal fields, retain the
  ledger rows and their ids. It is not the same operation as "delete my project".
- A retention job hard-deletes soft-deleted rows only once no `usage_event` in the retention window
  references them.
- Every list query pays a `deleted_at IS NULL` predicate — index accordingly. Forgetting it in one
  DAO leaks deleted rows into a UI, which is why the filter lives in the DAO layer rather than in
  each handler.

## Alternatives considered

**Hard delete with billing-history denormalization** — copy the project name and org name onto each
`usage_event` so the ledger is self-contained. Rejected: it multiplies text across a table projected
at ~14M rows/day, and the FK is still the thing that guarantees correctness.

**`ON DELETE SET NULL` on the billing FKs.** Rejected: an orphaned usage row cannot be attributed to
anything, which is the same data loss with extra steps.
