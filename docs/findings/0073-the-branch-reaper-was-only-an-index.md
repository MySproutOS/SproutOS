# The branch reaper was only an index

**Found:** 2026-08-28, by reconciling `private_notes/groups.md` and the sandbox handoff report with
the current agent action surface.

## What looked true

The sandbox received a copy-on-write Neon branch and a branch-scoped `DATABASE_URL`. The schema had
a partial `database_branch_reaper_idx`, `createDevBranch` described `expires_at` as being read by a
reaper, and the legacy plan required a 24-hour TTL plus a five-minute reaper. Together those names
read like a complete lifecycle.

## What was actually true

The handoff report stated the missing product behavior accurately: an agent received exactly one
branch and could not request another. There was no authenticated action, no sandbox environment
variable naming one, and no instruction teaching the agent how to call it.

More importantly, there was no branch reaper. An index is useful only to a query that exists, and
no job queried it. `sandbox.database_branch_id` could name only the default branch, so adding an API
without first adding an ownership relation would have made every additional branch invisible to
sandbox destruction. The result would be provider storage with no remaining row that explained who
created it or when to delete it.

## What stops this instance recurring

`sandbox_database_branch` records every branch owned by a sandbox, including the default branch.
Creation takes a row lock only long enough to self-heal ownership, enforce quotas, and commit a
short-lived reservation. Neon, KMS, and password hashing run after that transaction releases every
lock. The provider name encodes the complete sandbox and branch UUIDs, so a timed-out create can be
listed and adopted by an identity no other request can share. The provider id is persisted while
the reservation is still pending; a final compare-and-swap activates the row and its credentials.
If provider cleanup cannot be confirmed, the reservation stays in `cleanup` for the reaper rather
than erasing the only record of a possibly billable resource.

The short-lived agent bearer now exposes create and delete actions with live RBAC checks. Additional
branches expire after 24 hours, return their pg-proxy credential once under `Cache-Control:
no-store`, and cannot be confused with or delete the sandbox's default branch. The recurring worker
queries the existing expiry index and deletes provider state before its row; sandbox destruction
walks the complete ownership relation. Cleanup failures receive per-branch backoff, so one broken
old branch does not hide later rows. A minute repair job gives every `deleting` sandbox a fresh
destroy key even if its original job dead-lettered. Missing Daytona objects are cleaned and left
stopped; only another user request may rent a replacement. Tests cover negative action scope,
concurrent quota reservations, ambiguous provider success, failed cleanup durability, parent
selection, the canonical pg-proxy database name, refusal to delete the default, audit trail,
per-branch expiry isolation, destroy repair, and complete destruction.

This does not make Neon optional and does not substitute a local database or Docker sandbox for
Daytona. It adds a control-plane capability to the existing Daytona sandbox and continues to route
every returned credential through pg-proxy.
