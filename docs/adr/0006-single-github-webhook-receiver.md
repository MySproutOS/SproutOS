# 0006. One GitHub webhook receiver, dispatching by event type

- Status: Accepted
- Date: 2026-08-20

## Context

A GitHub App has exactly one webhook URL. Three research areas each claimed it.

The auth notes: `POST /api/v1/github/webhook`, receiving `installation`,
`installation_repositories`, and `github_app_authorization` (revocation). The compute notes:
`POST /api/v1/webhooks/github`, receiving `pull_request` and `push` to drive preview deployments.
The projects and store areas both assume `repository` events arrive somewhere for rename/transfer
tracking and metadata sync.

Nobody designed the fan-out. The webhook secret is named three different ways across the notes
(`GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_INSTALLATION_WEBHOOK_SECRET`),
which is the tell that three people assumed three endpoints.

## Decision

One receiver: `POST /api/v1/webhooks/github`, in `apps/internal-api`. It verifies the HMAC-SHA256
signature once against `GITHUB_APP_WEBHOOK_SECRET`, records the delivery for idempotency, returns
`202` immediately, and dispatches to per-event handlers by `X-GitHub-Event`.

Handled events at v1: `installation`, `installation_repositories`, `github_app_authorization`,
`repository`, `push`, `pull_request`.

## Consequences

- Signature verification needs the raw request body, so the route must be registered _before_ any
  JSON body parser and must not sit behind `authMiddleware`. It is unauthenticated by design; the
  signature is the authentication.
- Handlers are dispatch targets, not endpoints. A new event type is a new case in one switch, not a
  new URL and a new GitHub App setting.
- Slow work does not run inline. The receiver enqueues a job on the phase-2 background runner and
  acknowledges. GitHub's delivery timeout is short and retries are noisy.
- **Ordering is not guaranteed.** Treat `installation.deleted` as terminal and ignore late
  `installation.suspend` events by comparing timestamps rather than arrival order.
- One environment variable, `GITHUB_APP_WEBHOOK_SECRET`. The other two names in the notes are
  deleted.
- The OAuth App has no webhook. Everything webhook-shaped rides the GitHub App
  (see [0005](0005-both-oauth-app-and-github-app.md)).

## Alternatives considered

**Multiple GitHub Apps, one per concern.** Would give each area its own URL and secret. Rejected:
users would face several install prompts for one product, installation tokens would not be shared,
and the rate-limit budget would fragment.

**A thin edge receiver that re-posts to per-area services.** Rejected as premature — it adds a hop
and a second signing scheme before we have more than one deployed API.
