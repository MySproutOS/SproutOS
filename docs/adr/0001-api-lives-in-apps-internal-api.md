# 0001. The API is a separate app at `apps/internal-api`

- Status: Accepted
- Date: 2026-08-20

## Context

Ten of the thirteen research areas wrote route paths against one of two mutually
exclusive locations, and three of them listed the disagreement as an open question
rather than resolving it.

The RBAC notes hedged: "Files: `apps/internal-api/src/v1/{organizations,members,roles,invites}.ts`…
(Repo `AGENTS.md` says `apps/website/src/api` — see Open questions.)" The billing notes
committed the other way — "All under `apps/website/src/api/v1/billing.ts`" — as did the
compute notes: "All under `apps/website/src/api/v1/` (this repo embeds Hono in the website)."
The bootstrap notes settled it destructively, instructing us to "remove
`apps/website/src/api/**` (the whole embedded-API tree — the API is `apps/internal-api` now)".

The confusion has a traceable source. The committed `AGENTS.md` was copied from the sibling
waiting-list repo, where the Hono API genuinely is embedded in Next.js as a single Vercel
project. The scaffold we are actually cloning, `Andrew-Chen-Wang/nextjs-spa-split@main`, ships
`apps/internal-api` as its own deployment on port 3001.

## Decision

The API is `apps/internal-api`, a separate deployed application. Any embedded-API tree copied
from the waiting-list repo — `apps/website/src/api/**` and
`apps/website/src/app/api/[[...route]]/route.ts` — is deleted during bootstrap.

## Consequences

- The website and the API are different origins. The `session` cookie needs
  `Domain=.sproutos.dev` in production (deliberately `undefined` on localhost, where
  `:3000` and `:3001` are the same host), and the API must set CORS `credentials: true`
  against an explicit origin allowlist.
- `apps/website/src/proxy.ts` keeps validating sessions against Postgres directly rather than
  calling the API. The proxy must decide SSR-vs-SPA before any API hop; adding a network round
  trip there would put the cross-origin cookie problem on the landing page's hot path.
- The `.claude/skills/hono-backend-api` paths, which look like drift today, become correct.
- Rewriting `AGENTS.md` to describe the real five-surface architecture is a phase-1 deliverable.
- There are four dev servers to run, not one: website 3000, API 3001, dashboard SPA 3002,
  admin SPA 3003.

## Alternatives considered

**Embed Hono in Next.js under `/api`.** Same-origin cookies, one deployment, no CORS. Rejected:
both Vite SPAs are separate origins regardless, so the cross-origin problem does not actually
disappear — it just moves. Embedding also ties the API's deploy cadence and cold-start profile to
the Next.js build, and would mean diverging from the scaffold on day one in the one place the
scaffold is most opinionated.
