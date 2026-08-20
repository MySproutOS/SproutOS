# 0002. The tenancy table is `organization`; the UI says "Team"

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas designed two incompatible tenancy schemas, and one of them contains a foreign key to
a table nobody creates.

The RBAC notes define `organization(id, slug, name, kind CHECK in ('personal','team'),
owner_user_id, …)` with `organization_member`, and no `team` table anywhere. The agent notes
define `agent_credential` with "`team_id | uuid | FK team, not null`", plus endpoints
`GET/PUT /api/v1/teams/{teamId}/agent-config` and `GET /api/v1/teams/{teamId}/agent-usage`, and
RBAC actions `team:credential:write` and `team:billing:read`.

Billing uses `organization_id` throughout. The dashboard shell uses `/orgs/$orgSlug`. So a single
init migration written from these documents would produce a dangling FK on the very first agent
table.

Meanwhile the product language is genuinely "team": TASK 10 specifies that signup auto-creates an
organization named `"<Name>'s Team"`, and the sidebar control is a team switcher.

## Decision

The table is `organization`. There is no `team` table and there never will be. `organization.kind`
carries the `'personal' | 'team'` distinction. `agent_credential.team_id` becomes
`agent_credential.organization_id`; every `team_*` RBAC action becomes an `org:*` or resource-scoped
action from the single catalogue in [0016](0016-one-rbac-action-catalogue.md).

The **UI label** is "Team". Users see "Team settings", "Create team", "\<Name\>'s Team". The schema
noun and the display noun differ on purpose.

## Consequences

- Every agent-area endpoint path `/teams/{teamId}/…` is rewritten to `/orgs/{orgId}/…`, matching
  [0003](0003-orgs-url-prefix.md).
- One column name, `organization_id`, is the tenancy key across all ~81 tables. This is what makes
  a generic `requirePermission(action, srn)` middleware possible at all.
- Copy review is a real task: the dashboard must never leak the word "organization" into user-facing
  strings, or the product acquires two names for one thing.
- Anyone reading the research notes will see `team_id` and must translate. This ADR is the
  translation table.

## Alternatives considered

**Create a `team` table nested under `organization`.** A genuine two-level hierarchy (GitHub's
model: orgs contain teams) is defensible for large customers. Rejected for v1: nothing in the 36
backlog items needs sub-org grouping, RBAC would need a second scope axis in the SRN grammar, and
TASK 14's "unlimited teams" is satisfied by unlimited organizations.

**Rename everything to `team`.** Rejected: `organization` is already load-bearing in the RBAC,
billing, and OAuth-provider designs, and "personal organization" reads better than "personal team"
in a schema.
