# Dashboard SPA

React + Vite + TanStack Router, served under the apex domain by `apps/website/src/proxy.ts`. Runs on
**3002** in dev (`pnpm --filter=dashboard run dev`), but the real entry point is the website on 3000,
which rewrites authenticated requests here.

Components come from [`@ui/base`](../../../lib/typescript/ui/base/README.md); read that first for the
Base UI `render` prop, the amber-is-money rule, and the density table.

## Route tree

Org-scoped routes carry the slug in the path under `/orgs/` ([ADR 0003](../../../docs/adr/0003-orgs-url-prefix.md)).

```
/                                            → /dashboard
/dashboard                                   resolve last org → /orgs/$slug/projects
/orgs/$orgSlug                               shell (sidebar + outlet)
  /                                          → ./projects
  /projects                                  list · empty · loading · error
  /projects/$projectId                       overview + recent jobs
  /projects/$projectId/modify                form + danger zone
  /workflows
  /databases
  /observability                             stub — see below
  /settings                                  routed tab bar
    /                                        → ./profile
    /profile  /billing  /members  /api-keys
/store                                       shell (borrows current org)
  /                                          listing grid
  /$slug                                     listing detail
```

Anything else renders the root route's `notFoundComponent`.

Three things worth knowing:

**`/dashboard` is a real route that resolves and redirects**, not a static alias. ADR 0003 keeps it
that way so the OAuth callback can send everyone to one URL without knowing any org state; the target
comes from `user_preference.last_org_id` ([ADR 0004](../../../docs/adr/0004-last-org-in-user-preference.md)).

**`/store` renders the shell too.** It is a `SHARED_ROUTES` entry in `proxy.ts` — Next.js SSRs it for
logged-out visitors, and it rewrites here once the session cookie validates. It is not org-scoped, so
the shell borrows the reader's current organization; otherwise the sidebar and its balance would
vanish mid-browse. **`proxy.ts` still lists `/posting` rather than `/store`** — that file belongs to
another workstream, and until it is updated `/store` reaches this SPA only via client-side
navigation.

**`/observability` is a deliberate stub.** `design/parts/Main.html` puts it in the sidebar, so the
route has to exist for the nav item to be a typed link, but metrics and logs are their own task.

**Active-route styling rides `data-[status=active]`, not `activeProps`.** The router appends
`activeProps.className` to the end of the class attribute, but _CSS order_ decides which utility
wins — a plain `border-primary` loses to the base `border-transparent` and the highlight silently
never appears. The `data-` variant adds specificity, so it wins deterministically. This bit the
settings tabs before it was caught.

## Data layer: organizations are real, the rest are placeholders

Organizations, members, and the current user are wired to the real client. Project, store, billing,
workflow, database, and API-key endpoints do not exist yet. Rather than hand-write a parallel client,
every read lives in `src/data/*.ts` behind a hook that declares the query key and response shape it
expects and resolves a fixture through `usePlaceholderQuery` (`src/data/placeholder.ts`).

```
grep -rn "usePlaceholderQuery" src/data
```

lists everything still unwired. Each hook carries a `PLACEHOLDER —` docblock naming the generated
function it becomes.

| Module             | Hooks                                                          |
| ------------------ | -------------------------------------------------------------- |
| `organizations.ts` | `useOrganizations` `useOrganization` `useLastOrganizationSlug` |
| `projects.ts`      | `useProjects` `useProject`                                     |
| `workflows.ts`     | `useWorkflows` `useRecentJobs`                                 |
| `databases.ts`     | `useDatabases`                                                 |
| `billing.ts`       | `useCreditBalance` `useUsageLines` `useInvoices`               |
| `members.ts`       | `useMembers` `useApiKeys` (`useUserProfile` is **wired**)      |
| `store.ts`         | `useStoreListings` `useStoreListing`                           |
| `money.ts`         | `formatMicroUsd` — see below                                   |

### Wired to the real API

| Hook               | Endpoint                                            |
| ------------------ | --------------------------------------------------- |
| `useOrganizations` | `GET /v1/orgs`                                      |
| `useOrganization`  | `GET /v1/orgs/{orgSlug}`                            |
| `useMembers`       | `GET /v1/orgs/{orgSlug}/members`                    |
| `useUserProfile`   | `GET /v1/auth/me` (preferences half still fixtures) |

Two shape mismatches worth knowing, because the UI had to bend to the API rather than the reverse:

**`GET /v1/orgs` does not return the caller's role**, only `ownerUserId`. The team switcher therefore
says Owner or Member and nothing else — an admin reads as "Member" until the list response carries a
role. `GET .../members` does have real roles, but fetching it per organization to label one line of
the sidebar would be a request per team on every page.

**Member roles are org-defined RBAC rows**, not a fixed enum, so `Member.roleNames` is `string[]`.
`isOwner` renders its own badge and a role literally named `owner` is filtered out of the rest,
otherwise the same word appears twice.

**Dates from the API really are `Date`** — but only since the client generation was fixed, and the
failure it caused is worth remembering. `transformers.gen.ts` was being emitted with 51 response
transformers and `sdk.gen.ts` never imported or called one of them, so every `Date`-typed field
arrived as an ISO string. That typechecks perfectly and throws `RangeError: Invalid time value` at
render, which is how it reached a screen. Listing the `@hey-api/transformers` plugin does not
enable it; `transformer: true` on the `@hey-api/sdk` plugin is what wires it, and both
`.config/openapi-ts.config.ts` and the admin config now set it.

The `new Date(...)` coercions left at the boundaries are harmless — `new Date(aDate)` is valid — and
several of those helpers also take plain strings from callers that never went through the client.

### Nothing is placeholder-backed

`src/data/placeholder.ts` is gone and every hook on this screen calls a real endpoint, including
`useLastOrganizationSlug`, which reads `GET /v1/user/me/preferences` and lands a user on the team
they were last in rather than whichever sorts first.

Not consumed by any screen here, so deliberately unwrapped: roles, role actions, invites,
transfer-ownership, leave, and every mutation. Those belong to whoever builds the RBAC screens.

Swapping one over is mechanical: replace the body with `useQuery(getV1...Options(...))`, delete its
fixture. **Call sites do not change** — they only ever destructure `{ data, isPending, isError,
refetch }`. Query keys will change shape when hey-api's own keys take over; nothing outside
`src/data/` reads them.

`usePlaceholderQuery` resolves after 220ms on purpose, so the skeleton states are exercised in dev
rather than flashing past. `?empty` on any project-list URL forces the TASK 5 empty state; that
escape hatch goes away with the real endpoint.

### Money is `bigint` micro-USD

Every amount in `src/data/` is a `bigint` count of micro-USD — `costMicros`, `balanceMicros`,
`totalMicros` — never a float and never a pre-formatted string. That is the shape the real endpoints
return, so the fixtures model the domain rather than the screenshot.

Formatting goes through `formatMicroUsd` from **`@lib/billing/money`** — the subpath, never the
`@lib/billing` barrel, which re-exports `ledger.ts` (Kysely, pg) and `topup.ts` (the Stripe Node SDK
with a module-level client singleton). The subpath is safe only as long as `money.ts` stays
import-free. A verified build contains no Stripe, Kysely, or ledger code.

Resolution needs the `@lib/billing` alias in `vite.config.ts` and the matching `paths` entry in
`tsconfig.json`: the package's `exports` map turns `@lib/billing/money` into `./src/money` with no
extension, which neither tsc nor the bundler completes on its own. Same alias shape as every other
workspace package this SPA consumes.

Sub-cent precision is load-bearing on a metered product: a job costing `$0.0412` must not render as
`$0.04`, and `formatMicroUsd` keeps every significant decimal.

Two behaviours the real endpoints must preserve: switching organizations has to `queryClient.clear()`
rather than merely re-render — a stale `/orgs/{oldId}/…` cache entry rendering under the new org is
cross-tenant data exposure, not a cosmetic bug (ADR 0003) — and the project `glyph` is _user data_
(an emoji the owner picked), which is why it is the one place an emoji appears. Chrome icons are
lucide.

## The shell

`src/components/shell/` — built to `design/parts/Main.html`: 232px sidebar, 52px header, team
switcher at top, nav split by a rule, credit balance pinned at the bottom.

- **Collapsed rail** — 56px, icon-only, with tooltips, persisted in `localStorage`.
- **Mobile drawer** — below `md` the rail is hidden and the same `SidebarBody` renders inside a
  `Sheet`. `collapsed` is a desktop preference, so while the drawer is open the shared context
  reports _expanded_ (an icon-only drawer would be absurd), and the shell closes the drawer on the
  way back up past `md` so the two can never disagree on screen.
- **An unreachable org slug stops at the layout.** `/orgs/$orgSlug` gates on the lookup erroring and
  renders a "no access" screen instead of the shell. Falling through renders a fully working
  dashboard around an empty team switcher — a bookmarked URL for a team you were removed from would
  look like someone else's account loading, which is worse than an error. Only `isError` gates, so an
  in-flight lookup does not flash a spinner on every navigation.
- **The root route has an `errorComponent`.** Without one, a render error anywhere takes the whole
  SPA to a blank page and TanStack only warns in the console. A route's own error state covers a
  failed request; this covers the bug that request data provokes.
- **`PageHeader` is per-route**, not part of the shell: every screen's controls differ, and the shell
  guessing them would be wrong on all of them. It also owns the mobile drawer trigger.

## Deviation from the artboard

`design/parts/Main.html` draws the **Workflows** nav item with lucide's `dollar-sign` glyph. That is
almost certainly a slip in the artboard, and shipping it would put a currency symbol on a
non-financial nav item in a product whose central visual rule is that money has its own channel. The
sidebar uses `WorkflowIcon` instead. Every other icon matches the artboard's paths exactly, including
`merge` for Store and `globe` for Observability.

## Known lint noise

The SPA emits `react-perf/jsx-no-{jsx,new-object,new-function}-as-prop` warnings (not errors — lint
passes). All three are unavoidable here: `render={<Link />}` is Base UI's only composition escape
hatch, `params={{ orgSlug }}` is TanStack Router's API, and inline handlers are memoized by the React
Compiler, which is enabled in `vite.config.ts` and does by machine exactly what those rules ask for by
hand. Worth disabling for React-Compiler packages in `oxlint.config.mts`.

## Environment variables

`/orgs/$orgSlug/projects/$projectId/env`, backed by the `project_env_var` routes that already
existed on the API.

**Four environments, and one of them is a fallback.** `production`, `preview`, `development`, and
`all`. A tab shows what that environment would actually _see_ — its own variables plus the `all`
fallbacks — because listing only exact matches would show an empty Production tab for a project
whose variables are all set once, which is the common case.

`preview` is the ephemeral environment: one deployment per open pull request. It is deliberately
not called "staging". A long-lived staging tier would be a fifth value and a CHECK constraint
change; today, promoting a preview variable to production is a target edit on the row.

**Reveal is a POST and is never cached.** Decrypting a value writes an `audit_log` row, so a cached
read would make the audit trail claim one look when there were five. The plaintext lives in the
component that asked for it and nothing else — navigating away unmounts it, and it never enters the
query cache where the next page would inherit it.

**The Secret switch does not control encryption.** Every value is envelope-encrypted regardless;
the flag only decides whether the value is masked in build logs and deploy output. The dialog says
so, because a switch labelled "Secret" next to an unencrypted alternative is a promise nobody made.

The add dialog is controlled rather than wrapping Save in a `DialogClose`: a rejected save has to
leave the dialog open with the typed value still in it, and only a successful one closes.

## Agent chat

`/orgs/$orgSlug/projects/$projectId/agent`.

**The stream is parsed here, not by the browser.** `EventSource` only issues GET requests and the
prompt has to be a body, so the transport is `fetch` plus a stream reader — which makes SSE framing
our problem. A chunk can split a frame anywhere, including through the middle of a JSON payload, so
the tail stays in a buffer until its blank-line terminator arrives. `agent-chat.test.ts` asserts
that directly; the naive parse-each-chunk version drops the event entirely.

**A refusal is not a chat response.** No credential, no credit, no GitHub App — these arrive as
ordinary JSON before the stream starts, and the client raises the API's own message rather than
rendering an empty bubble. The envelope is OData-shaped (`{ error: { code, message } }`), and
reading a bare `message` degrades silently to a generic "the agent could not start", which is how
this was wrong the first time and why there is a test pinning the shape.

**Consecutive text events merge.** The agent emits a content block at a time; a bubble per block
shreds a paragraph into a column of fragments.

**Leaving the page aborts the run.** A stream into an unmounted component keeps burning tokens
against a balance nobody is watching.

## Databases

`/orgs/$orgSlug/databases`, backed by the `@lib/services` driver from TASK 37. A database can stand
on its own or belong to a project — the create dialog does not ask, because the API does not
require one.

**The connection URI is on screen exactly twice**: once when the database is created, and once per
explicit reveal. It is never in the list response, because a URI in a list is cached by clients,
logged by proxies, and rendered on pages nobody meant to expose. Both dialogs say that reading it
again is recorded in the audit log, because it is.

Reveal and rotate are mutations, not queries. Each writes an audit row, so a cached read would make
the trail claim one look when there were five. Neither result enters the query cache — the URI
lives in the component that asked for it.

**Deleting asks you to type the name.** Every other destructive action here is recoverable;
this one destroys a customer's data outright, with no backup to restore from. Rotating gets a
plain confirmation instead, and says what breaks: every client still using the old URI.

Engines that are not implemented appear in the picker marked "coming soon" and disable the create
button, rather than being hidden. A person looking for Valkey should find out it is planned, not
conclude it does not exist.
