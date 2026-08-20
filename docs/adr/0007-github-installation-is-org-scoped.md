# 0007. `github_installation` is org-scoped

- Status: Accepted
- Date: 2026-08-20

## Context

`github_installation` is defined twice in the research, with incompatible shapes, and each
definition answers the other's open question the opposite way.

The auth notes define it user-scoped: `(installation_id, account_login, account_type,
target_user_id FK user, repository_selection, permissions jsonb, suspended_at, deleted_at)`, with
`target_user_id` "set only after we verify ownership via the user token". That area's open question
4 asks: "Should org-owned installations be shared across SproutOS users in the same org, or strictly
bound to the installing user?"

The projects notes define it org-scoped: `(organization_id, installation_id, account_login,
account_type, repository_selection, suspended_at)` — no `target_user_id` — and silently answer the
question in the opposite direction. `repository.installation_id` points at whichever one exists.

The product decides this, not the schema. A repository belongs to an organization in SproutOS
(`repository.organization_id`), fork upkeep runs headlessly long after the installing user may have
left, and billing for upkeep is charged to the org. An installation bound to a departed employee's
user row is an outage waiting to happen.

## Decision

One table, org-scoped:

```
github_installation(
  id, organization_id FK organization, installation_id bigint UNIQUE,
  account_login, account_type CHECK ('User','Organization'),
  repository_selection CHECK ('all','selected'),
  permissions jsonb, installed_by_user_id FK user NULL,
  suspended_at, deleted_at
)
```

`installed_by_user_id` is retained as provenance and for the setup-URL ownership check, but it is
**not** the access-control key. Access is by `organization_id`.

## Consequences

- Any org member with the right RBAC action can use the installation; membership is the boundary,
  which is consistent with every other org-owned resource.
- The setup-URL callback must still verify ownership: `installation_id` on the setup URL is
  attacker-controlled, and GitHub explicitly warns it can be spoofed. Verify against
  `GET /user/installations` with the installing user's token before writing the row.
- `deleted_at` is retained (soft delete on `installation.deleted`) because `repository` rows point at
  installations and billing history references those repositories — see
  [0017](0017-soft-delete-on-billing-referenced-tables.md).
- Revocation must cascade: on `installation.deleted`, set `project.auto_update_enabled = false` for
  every project on repositories bound to that installation, or upkeep starts failing silently at
  3 a.m.
- A user installing on a personal GitHub account still produces an org-scoped row — bound to their
  personal organization, which exists for every user by construction.

## Alternatives considered

**User-scoped with `target_user_id`** (the auth design). Rejected: headless upkeep would break when
the installing user leaves the org, and two members of the same org forking the same store app would
need two installations on the same GitHub account.

**Both columns, nullable, one populated.** Rejected: two access-control paths through one table is
how authorization bugs are written.
