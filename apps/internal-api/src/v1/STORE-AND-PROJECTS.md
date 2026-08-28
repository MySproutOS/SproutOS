# The store and the project lifecycle

Companion to [`README.md`](README.md), which covers tenancy and `requirePermission`. Everything
org-scoped here is gated by that function; this file is about the decisions those routes make on
top of it.

Tasks: 4, 5, 8, 15, 17, 18, 21, 31.

## Routes

### The catalogue is public

| Method | Path                              | Auth                           |
| ------ | --------------------------------- | ------------------------------ |
| GET    | `/v1/store/categories`            | none                           |
| GET    | `/v1/store/tags`                  | none                           |
| GET    | `/v1/store/featured`              | none                           |
| GET    | `/v1/store/listings`              | none                           |
| GET    | `/v1/store/listings/:slug`        | none                           |
| POST   | `/v1/store/listings/:slug/events` | none (attributed if signed in) |

`authNoThrowMiddleware`, not `authMiddleware`. TASK 4 requires the store to be visible to someone
who has never signed in, and `apps/website/src/proxy.ts` lists `/store` under `SHARED_ROUTES` so
the same URL renders as Next.js SSR when logged out. A session, when there is one, is used only to
attribute a `store_listing_event` row.

**Only `published` listings are ever served.** The status predicate is an argument to
`browseQuery`, not a default, so a caller who forgets it gets a type error rather than the
moderation queue on the internet. Community submissions are untrusted markdown: an unreviewed body
is not merely absent from the list, it is unreachable by slug.

### Moderation is org-scoped, and it says so in the path

| Method | Path                                                    | Action                   |
| ------ | ------------------------------------------------------- | ------------------------ |
| GET    | `/v1/orgs/:orgSlug/store/listings`                      | `store:listing:moderate` |
| POST   | `/v1/orgs/:orgSlug/store/listings/:listingId/publish`   | `store:listing:moderate` |
| POST   | `/v1/orgs/:orgSlug/store/listings/:listingId/unpublish` | `store:listing:moderate` |

The catalogue is global but `requirePermission` is not — it evaluates grants inside one
organization and builds the SRN from the one it resolved. Hanging moderation off `/v1/store` would
have made it fall back to `user_preference.last_org_id`, so a moderator who belongs to two
organizations would get different answers depending on which tab they last opened, and the
`audit_log` row would name whichever organization that happened to be. The slug in the path makes
the acting organization explicit and auditable.

Unpublishing never deletes. ADR 0015 makes `project.store_listing_id` `ON DELETE SET NULL`
precisely so archiving is not blocked by the projects forked from a listing, and those projects
keep their provenance link for as long as the row survives.

### Projects

| Method | Path                                                         | Action             |
| ------ | ------------------------------------------------------------ | ------------------ |
| GET    | `/v1/orgs/:orgSlug/projects`                                 | `project:read`     |
| POST   | `/v1/orgs/:orgSlug/projects`                                 | `project:create`   |
| GET    | `/v1/orgs/:orgSlug/projects/:projectId`                      | `project:read`     |
| PATCH  | `/v1/orgs/:orgSlug/projects/:projectId`                      | `project:update`   |
| DELETE | `/v1/orgs/:orgSlug/projects/:projectId`                      | `project:delete`   |
| GET    | `/v1/orgs/:orgSlug/projects/:projectId/jobs`                 | `project:read`     |
| GET    | `/v1/orgs/:orgSlug/projects/:projectId/jobs/:jobId`          | `project:read`     |
| GET    | `/v1/orgs/:orgSlug/projects/:projectId/env`                  | `project:read`     |
| PUT    | `/v1/orgs/:orgSlug/projects/:projectId/env`                  | `credential:write` |
| DELETE | `/v1/orgs/:orgSlug/projects/:projectId/env/:envVarId`        | `credential:write` |
| POST   | `/v1/orgs/:orgSlug/projects/:projectId/env/:envVarId/reveal` | `credential:read`  |
| GET    | `/v1/orgs/:orgSlug/projects/:projectId/update-suggestions`   | `project:read`     |
| POST   | `…/update-suggestions/:suggestionId/accept`                  | `project:update`   |
| POST   | `…/update-suggestions/:suggestionId/dismiss`                 | `project:update`   |
| GET    | `/v1/orgs/:orgSlug/repositories`                             | `repository:read`  |
| GET    | `/v1/orgs/:orgSlug/github/repositories`                      | `github:read`      |

Every `fetch*` takes the organization id alongside the resource id — `getInOrganization`, never
`getOne`. `requirePermission` authorizes an action against an SRN it builds from the resolved
organization plus a path parameter it does not verify, so a project id belonging to another
organization produces a well-formed SRN in _this_ one and passes the check. The DAO predicate is
the only thing between that and a cross-tenant read, and `projects.test.ts` asserts it directly.

## `repository` and `project` are two entities, not one

TASK 21: two projects may be two directories or two branches of one repository. So upkeep runs per
**repository** — one comparison against upstream — and deploys run per **project**. One
`upstream_sync_run` fans out into one `project_update_suggestion` per project on that repository
and branch, which is not expressible if the two are collapsed.

The consequences the routes have to carry:

- `POST /projects` with `source.type = "repository"` writes **no** `repository` row. A second row
  for the same GitHub repo would give upkeep two places to run and two places to disagree.
- The partial unique index `(organization_id, repository_id, root_dir, production_branch)` is the
  authority on collisions. The route checks first so the answer is a 409 naming the project that
  already occupies that target, rather than a constraint violation surfacing as a 500.
- Deleting a project releases the repository **only** when it was the last live project on it.
  Deleting the first of two would otherwise take upkeep away from the other.

### The negative `github_repo_id`

`project.repository_id` is `NOT NULL`, so a project row cannot exist until a repository row does —
and provisioning is asynchronous, so the real numeric id does not exist yet. `github_repo_id` is
`NOT NULL bigint` under a partial unique index on `(organization_id, github_repo_id)`, which rules
out a shared sentinel: two projects created in one organization before either finished would
collide on it.

GitHub's ids are always positive, so the negative half of the range is free.
`pendingGithubRepoId()` derives a placeholder from the low 60 random bits of the repository row's
own UUIDv7 — unique per row without a second round trip, and "has this been created upstream yet"
becomes a sign test. The API reports `pendingCreation: true` and `githubRepoId: null` rather than
handing a client a number that means nothing.

## One entry point, asynchronous provisioning

The store's fork button, "start from scratch", and "add another project on a repo I already have"
are all `POST /v1/orgs/:orgSlug/projects`, differing only in `source`. They share slug allocation,
credential resolution, the job, and the audit row; two endpoints would be two places to forget the
auto-update default.

The handler creates the rows in one transaction and returns `{ project, job }` with the project in
`state: 'creating'`. It asks GitHub for nothing. A fork takes seconds to minutes and GitHub
answers `202` before the repository is clonable, so doing it inline would produce a request that
times out and a repository nobody has a row for. Clients poll `GET …/jobs/:jobId`, which carries a
step list written at enqueue time so there is something to render in the second before a worker
picks the job up.

`project_job.idempotency_key` is unique. A repeated fork click is the common case and the
expensive half of it happens on GitHub, so the second click is a no-op rather than a second
repository.

## Environment variables

Values are envelope-encrypted with `@lib/envelope` under the standard three-column convention
(`value_ciphertext`, `value_wrapped_dek`, `value_kms_key_id`). The encryption context binds
`projectId` **and** the key name:

```ts
{
  field: ("project_env_var.value", key, projectId)
}
```

Both halves matter. Without `projectId`, a ciphertext could be moved between projects; without
`key`, `DATABASE_URL`'s ciphertext could be written onto the `STRIPE_KEY` row inside the same
project and would decrypt cleanly. `target` is deliberately _not_ bound — promoting a preview
variable to production is a row edit, and binding it would make that a re-encrypt for no gain.

The "no plaintext in a list" rule is enforced by the shape of the DAO, not by the route's
discretion. `listForProject` and `getMetadata` take no `fields` argument at all — the ciphertext
columns are simply not reachable through them, so there is no longer field array to pass. Reading
a value is `getSealed`, a different function behind a different RBAC action
(`credential:read` rather than `project:read`), and every reveal writes an `audit_log` row after
the decrypt succeeds. The audit row names the variable and never its value: `before`/`after` land
in `jsonb` on an append-only table, so a secret written there literally cannot be removed.

Deletion of a variable is a hard delete. No durable billing or audit row references
`project_env_var`, and a soft-deleted row would leave a decryptable secret after the user asked for
it to be gone.

## Delete is soft, and the response says exactly what that means

ADR 0017. `usage_rollup` and `statement_line_item` reference `project` with `ON DELETE RESTRICT`, so
a hard delete either fails or destroys billing history that justifies charges already made.
Deletion is a state change plus a teardown job:

```json
{
  "project": { "state": "deleting", "deletedAt": "…" },
  "job": { "kind": "delete", "state": "queued" },
  "destroyed": [],
  "scheduledForTeardown": ["deployment", "backend_service", "database_instance", "…"],
  "retained": ["usage_rollup", "statement_line_item", "audit_log"],
  "repositoryReleased": false,
  "remainingProjectsOnRepository": 1,
  "message": "…"
}
```

`destroyed` is empty and stays empty: the request destroys nothing outside the database. The test
suite asserts the retained half by inserting a `usage_rollup`, deleting the project, and then
showing both that the billing grain still resolves to the project's name and that a raw
`DELETE FROM project` is refused by Postgres.

## Upstream update policy

TASK 17. `auto_update_enabled` is not a product setting or a tier — it is resolved from
`agent_credential.kind` at creation:

| Credential kind                                               | Default |
| ------------------------------------------------------------- | ------- |
| `claude_subscription`                                         | **on**  |
| `anthropic_api_key` / `openai_api_key` / `openrouter_api_key` | off     |
| none connected                                                | off     |

A subscription is flat-rate, so scheduled upkeep costs the customer nothing beyond what they already
pay. Every other kind is metered per token, and an agent that wakes up to reconcile a fork against
upstream would spend real money nobody authorized. `autoUpdateDefaultFor()` in
`@lib/dao` is the single expression of that rule; an explicit `autoUpdateEnabled` in the request
still wins.

`auto_update_enabled = false` is the canonical Off state. `auto_update_cadence` separately stores
`tag`, `daily`, `weekly`, or `monthly`, so switching Off does not erase the customer's interval.
Daily, weekly, and monthly mean complete 1-, 7-, and 30-day intervals since the last recorded run;
an overdue repository stays due, so a worker outage cannot lose its window. If several projects
share one repository, the shortest due cadence wins and the repository is still reconciled once.

Tag mode polls daily and fingerprints the complete set of upstream tag names and target commits.
It triggers the ordinary guarded sync when that fingerprint changes; it is not a SemVer parser or
a request to pin the fork at one release. An unchanged tag poll updates only the repository's
checked-at timestamp and does not create a fictitious successful sync run.

Both forks and template-generated copies retain `repository.upstream_full_name`. Eligibility keys
on that recorded provenance, not GitHub's `is_fork` bit, so a template copy is not silently omitted
from scheduling. Forks use GitHub's guarded `merge-upstream`; copies use a trusted, non-checkout
three-way tree merge because their generated root has unrelated Git history. The worker proves the
base by matching that root tree to upstream history, records the applied upstream SHA for later
runs, and refuses conflicts or an unprovable base rather than overwriting customer changes.

When no credential is named, `getDefaultForOrganization` prefers a subscription over an API key —
the one whose marginal cost is already paid for.

## Platforms

`store_listing.platform` is filterable from day one across every value the check constraint
allows: `web`, `android`, `ios`, `windows`, `macos`, `linux_debian`. Only `web` has an
implementation (TASK 18 defers the runtimes, not the vocabulary), so a client asking for `android`
today gets an empty page rather than a 400 — and the facet does not change shape when a runtime
lands.

## Two things worth knowing before you extend this

**`cursorOffsetPaginate` cannot page past the first page.** It emits a cursor whose position field
is the literal string `"limit/offset"` (`utils/pagination.ts:127`), and `decodeCursor` validates
that field as a UUID (`:42`) — so every cursor it produces is rejected as "Invalid position" by
the next request. Nothing here uses it. That is why the store catalogue is ordered by
`store_listing.id` (UUIDv7, hence newest first), which is the only ordering the surviving
keyset-with-anchor cursor can describe, and why ranked ordering lives on the unpaginated
`/store/featured` rail instead. Fixing the paginator would let `/store/listings` accept a
`sort=stars` facet; it is outside this change's file boundary.

**Nothing in the request path writes to GitHub.** `GET …/github/repositories` is the one route
that calls the API at all, and it is a read that returns a 503 naming `GITHUB_APP_PRIVATE_KEY`
when the key is absent — which it is in a fresh checkout. Everything that creates, forks, or
generates a repository is the responsibility of the `project_job` runner, which is not part of
this change. See [`@lib/github`](../../../../lib/typescript/github/README.md) for the client and
the credential split it enforces.
