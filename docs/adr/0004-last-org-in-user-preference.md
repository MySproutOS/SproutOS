# 0004. Last-visited org is stored in `user_preference.last_org_id`

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas designed storage for the same fact.

The RBAC notes place it on the user row: "`user.last_org_id` only as the redirect target for bare
`/dashboard`". The dashboard-shell notes create a whole table for shell state:
"`user_preference` … `last_org_id` uuid … drives the `/dashboard` redirect", alongside
`sidebar_collapsed` and `nav_pinned_project_ids`.

Two writers for one meaning is how a field goes stale. It also matters which table owns it, because
the column carries an FK to `organization` — putting it on `user` means the `user` table, created
first in any migration ordering, would need a back-patched constraint or a deferred FK to a table
created several steps later.

## Decision

`user_preference.last_org_id`, `NULL REFERENCES organization(id) ON DELETE SET NULL`. The `user`
table gains no org-aware columns. `user_preference` is created after `organization` in the migration
ordering, so the FK is declared inline with no back-patch.

`user_preference` is the single home for per-user shell state: `last_org_id`, `sidebar_collapsed`,
`nav_pinned_project_ids`, one row per user, `UNIQUE (user_id)`.

## Consequences

- `GET /api/v1/me/preferences` is the shell bootstrap call: last org, collapse state, pins, in one
  round trip. `PATCH` is the single writer.
- The row is created lazily on first write, so the login path does not need to insert it. Every
  reader must tolerate its absence and fall back to "first org by membership".
- `ON DELETE SET NULL` means deleting an organization degrades the redirect to the resolver's
  fallback rather than breaking `/dashboard` — which matters because org deletion is a real
  supported operation.
- Sidebar collapse also writes the client-side `sidebar_state` cookie so the SSR `/store` page
  renders at the same width with no flash. The cookie is a rendering hint; the table is the truth.
  The cookie must never carry org identity, since it is sent on every request to the apex domain.
- The `user` table stays close to the scaffold's shape, which keeps `lib/typescript/dao/src/user/`
  and the session validation path in `proxy.ts` untouched.

## Alternatives considered

**`user.last_org_id`.** One fewer table and one fewer join on the shell bootstrap. Rejected: it forces
an org FK onto the first table in the migration graph, and the shell needs `sidebar_collapsed` and
pins anyway — so the table exists regardless and the column belongs with its siblings.

**Client-only, in `localStorage`.** Rejected: TASK 12's team switcher is expected to persist across
devices, and a logged-in user landing on `/dashboard` from an email link on a new machine should
reach the org they last used.
