# 0016. One RBAC action catalogue, colon separators only, SRN resources everywhere

- Status: Accepted
- Date: 2026-08-20

## Context

The RBAC area froze a grammar. Seven other areas then invented their own vocabularies against it.

The RBAC catalogue: `org:{read,update,delete,transfer_ownership}`, `member:{…}`, `role:{…}`,
`project:{…}`, `billing:{read,write}`, `apikey:{…}`, `workflow:{read,run,**job.peek**,**job.update**}`,
`db:{read,branch.create,branch.delete}`, `store:fork`, `observability:logs.read`.

What consumers actually wrote: `workflow:job:read` / `workflow:job:modify` (workflows);
`database:create|read|delete|branch|connect|admin` (data plane); `deployment:read|write|promote`,
`sandbox:*`, `usage:read` (compute); `project:agent:write`, `team:credential:write` (agent);
`store.listing:moderate` (store); `oauth_client:*` (OAuth provider); `infra:read|write` (infra).

None of those appear in the catalogue, and the separator is mixed — `.` in some, `:` in others.
That matters because RBAC Decision 4 expands action wildcards on separator boundaries:
`workflow:job.peek` expands to `*`, `workflow:*`, `workflow:job.*`, and the exact string. Under a
`.`-aware expander, `workflow:job:read` expands differently, and a role granting `workflow:*` may or
may not cover it depending on which expander ran.

The resource axis has the same problem. RBAC Decision 2 freezes SRNs —
`srn:sproutos:<service>:<org_id>:<type>/<id>` — and warns to "freeze the grammar before the first
custom role ships", because changing it later is a data migration over customer-authored `text[]`
columns. The data-plane notes then write `["project:<id>"]`, which is not an SRN.

## Decision

- **One catalogue**, defined in one TypeScript module, exhaustive, and every route's
  `requirePermission()` argument comes from it. Adding an action means adding it there.
- **`:` is the only separator.** Actions are `<service>:<subject>:<verb>` or `<service>:<verb>`.
  `workflow:job:read`, `workflow:job:modify`, `database:branch:create`, `store:listing:moderate`.
  No dots anywhere in an action string.
- **Wildcards expand on `:` boundaries only**, producing the ancestor set
  (`*`, `workflow:*`, `workflow:job:*`, exact) matched by array overlap.
- **Every resource is an SRN.** `srn:sproutos:<service>:<org_id>:<type>/<id>`, with `*` legal as a
  whole segment or as the trailing id. The bare string `*` means everything. No bare
  `project:<id>` strings.
- The grammar is **frozen in phase 4**, before the first custom role is persisted.

## Consequences

- Every area's action strings are rewritten to the catalogue. `team:credential:write` becomes
  `credential:write` scoped by the org segment of the SRN, per
  [0002](0002-tenancy-noun-is-organization.md).
- Permission checks are one indexed query against `member_permission` —
  `actions && $expanded AND resources && $expanded`, with `bool_or(effect = 'deny')` evaluated in the
  _same_ query. GIN `array_ops` on both columns.
- **Deny must be in the same query.** A member with a broad `*` allow and a narrow `deny` matches
  both rows; forgetting `bool_or` grants access.
- **Never express "has all of X and Y" as a single `@>`.** Postgres evaluates containment per row, so
  two permissions held via two different roles return false. Check each separately, or aggregate.
- The `<org_id>` segment is always built from `c.var.organization.id`, never from request input, or a
  caller supplies an SRN in an org they belong to while acting on another.
- OAuth scopes reuse this catalogue rather than inventing a second vocabulary, so a token's effective
  permission is the intersection of the user's RBAC set and the granted scopes, computed per request.

## Alternatives considered

**Let each area own its own namespace.** Rejected: the wildcard expander is one function, and
divergent separators make `service:*` mean different things in different routes — a security bug, not
a style inconsistency.

**Bare resource ids instead of SRNs.** Simpler strings. Rejected: without the org segment, a resource
id in a role statement is ambiguous across orgs, and wildcard scoping ("all projects in this org")
has nowhere to live.
