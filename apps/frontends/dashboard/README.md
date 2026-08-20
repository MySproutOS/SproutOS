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

## Data layer: one hook is real, the rest are placeholders

Only `/v1/auth/me` exists in the generated client in this tree. The organization, project, billing,
workflow, database, member, and store endpoints do not. Rather than hand-write a parallel client,
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

### Swap map for the org API

`useUserProfile` is already wired to `getV1AuthMeOptions()` — the one v1 route that exists in this
tree — with only its two `user_preference` fields (`timezone`, `productEmails`) left as fixtures.

The rest wait on the regenerated client. Each is a one-for-one body replacement:

| Hook               | Endpoint                         |
| ------------------ | -------------------------------- |
| `useOrganizations` | `GET /v1/orgs`                   |
| `useOrganization`  | `GET /v1/orgs/{orgSlug}`         |
| `useMembers`       | `GET /v1/orgs/{orgSlug}/members` |

`useLastOrganizationSlug` has no endpoint on that list. ADR 0004 puts the target in
`user_preference.last_org_id`; until that is exposed it returns the first organization from
`GET /v1/orgs`, which is a correct-but-arbitrary fallback rather than the user's actual last team.

Not consumed by any screen in this app, so deliberately unwrapped: roles, role actions, invites,
transfer-ownership, and every mutation. Those belong to whoever builds the RBAC screens.

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

Formatting goes through the single function in `src/data/money.ts`, which is a **stand-in for
`@lib/billing`'s `formatMicroUsd`**. That package is not in this working tree yet — it arrived with
PRs #8/#9, this branch is at #7, and `lib/typescript/billing/` currently holds only `node_modules/`.
Once the merge lands: add `"@lib/billing": "workspace:*"` to `package.json`, point the eight import
sites at `@lib/billing` instead, and delete `src/data/money.ts`. No other code changes.

Sub-cent precision is load-bearing on a metered product: a job costing `$0.0412` must not render as
`$0.04`, so the formatter keeps up to four decimals and trims back to a minimum of two.

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
