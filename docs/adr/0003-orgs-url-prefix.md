# 0003. Org-scoped URLs use the `/orgs/$orgSlug/` prefix

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas put the current organization in the URL and picked different prefixes.

The RBAC notes, Decision 8: "Current org lives in the URL: **`/o/:orgSlug/...`**", reasoning that a
cookie-borne tenant id is a confused-deputy hazard and breaks multi-tab and link-sharing.

The dashboard-shell notes, Decision 1: "Org lives in the URL under an explicit **`/orgs/$orgSlug/`**
prefix, not implicit session state, because a bare `/$orgSlug/...` wildcard collides with
`proxy.ts`'s static prefix lists."

Both agree the org belongs in the path. They disagree on one character, which is enough to make
every route path in the RBAC frontend section wrong under the dashboard's decision and vice versa.

The tiebreaker is mechanical. `apps/website/src/proxy.ts` classifies requests against static prefix
lists — `NEXTJS_PUBLIC_PREFIXES` (`/login`, `/blog`, `/legal`), `SHARED_ROUTES` (`/store`), and
`/admin*`. A short prefix like `/o/` is fine, but the reasoning behind it was really about avoiding a
bare `/$orgSlug/` wildcard, and a longer, unambiguous segment is cheaper to reason about when the
prefix list grows. `/orgs/` also cannot collide with a two-letter route we might want later.

## Decision

Org-scoped routes are `/orgs/$orgSlug/…` in both the TanStack Router tree and any Next.js path.
`/dashboard` stays a real route that resolves-and-redirects to `/orgs/$slug/dashboard`, so TASK 5's
"redirected to /dashboard upon login" holds without the OAuth callback needing to know org state.

## Consequences

- User-scoped settings live at `/settings/*` (profile, appearance, apps I authorized); org-scoped
  settings live at `/orgs/$slug/settings/*` (billing, members, roles, model config, danger zone).
  The split is by resource ownership, and billing and RBAC are org-owned, so the org must be in
  the path.
- Org slugs need a reserved-word denylist at creation (`new`, `settings`, `admin`, `store`, `login`)
  even though the prefix removes the collision with top-level routes.
- Switching teams must `queryClient.clear()`, not merely re-render. A stale `/orgs/{oldId}/…` cache
  entry rendering inside the new org is a cross-tenant data exposure, not a cosmetic bug.
- The redirect target comes from `user_preference.last_org_id` — see
  [0004](0004-last-org-in-user-preference.md).

## Alternatives considered

**`/o/:orgSlug/`** — shorter, Vercel-like. Rejected only on the ambiguity argument above; there is no
technical defect. If we ever want it, a permanent redirect from `/o/*` to `/orgs/*` is trivial.

**Org in a cookie, clean URLs.** Rejected outright by both research areas for the same reason: two
browser tabs on two teams become impossible, every shared link is ambiguous, and a request whose
tenancy comes from a cookie is the textbook confused-deputy setup.
