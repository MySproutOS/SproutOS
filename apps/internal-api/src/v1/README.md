# Tenancy, RBAC, and the org-scoped routes

Everything under `/v1/orgs/:orgSlug/…` is gated by `requirePermission`, which is the most
depended-upon function in the product: every route in every later phase imports it. This file is
the contract it implements.

## The three pieces

| Piece                | Lives in                                     | Answers                       |
| -------------------- | -------------------------------------------- | ----------------------------- |
| The action catalogue | `src/rbac/actions.ts`                        | What may be done              |
| The SRN grammar      | [`@lib/srn`](../../../../lib/typescript/srn) | What it may be done to        |
| The evaluation query | `@lib/dao` `memberPermission`                | Whether this member may do it |

## The action catalogue

One module, exhaustive, `:` as the only separator (ADR 0016). Actions are `<service>:<verb>` or
`<service>:<subject>:<verb>`. Adding an action means adding it to `ACTIONS` in `src/rbac/actions.ts`
and nowhere else — OAuth scopes reuse the same list rather than inventing a second vocabulary.

```text
org:        read update delete transfer_ownership
member:     read invite update remove
role:       read create update delete
audit:      read
billing:    read write refund
usage:      read
apikey:     read create revoke
credential: read write
github:     read write
project:    read create update delete
repository: read write
deployment: read write promote
sandbox:    read write
workflow:   read run job:read job:modify
database:   read create delete connect admin branch:create branch:delete
search:     read write
cache:      read write
observability: logs:read
store:      fork listing:publish listing:moderate
oauth_client:  read create update delete
infra:      read write
```

A role statement may also hold a wildcard form — `*`, `workflow:*`, `workflow:job:*` — but only
where the catalogue actually has an action under that prefix. `isGrantableAction` enforces that at
the roles endpoint, so a typo like `project:writ` is a 400 rather than a stored grant that matches
nothing and reads as working in the UI.

**Expansion is on `:` boundaries only.** A request for `workflow:job:read` expands to
`["*", "workflow:*", "workflow:job:*", "workflow:job:read"]`, and a grant matches when the two
arrays overlap. This is why no action may contain a dot: under a dot-aware expander,
`workflow:job.read` would expand differently and `workflow:*` might or might not cover it depending
on which expander ran.

## Deny wins

Statements are IAM-shaped: an effect, an action array, and a resource-SRN array. **A deny anywhere
beats every allow, unconditionally, with no notion of specificity.** The `admin` system role is
built entirely on this: it holds `allow *` and `deny org:delete, org:transfer_ownership,
billing:write, billing:refund` as two separate rows, so an admin can do everything except the four
things that end the organization or spend its money.

Both effects are read in **one query**, never two:

```sql
SELECT bool_or(effect = 'allow') AS allowed,
       bool_or(effect = 'deny')  AS denied
FROM member_permission
WHERE user_id = $1
  AND organization_id = $2
  AND actions   && $3::text[]   -- the expanded action set
  AND resources && $4::text[]   -- the expanded target SRN set
```

Access is `allowed && !denied`. Splitting this into two round trips would let a role edit land
between them; checking only for an allow hands an admin the delete button.

Indexes: `member_permission_user_organization_idx` btree `(user_id, organization_id)` narrows to the
member, and `member_permission_actions_resources_gin_idx` GIN `(actions, resources)` serves both
`&&` predicates.

### The resource side is expansion, not matching

Grants are stored as SRN _patterns_ with wildcards. Postgres cannot run the pattern matcher, so the
query inverts the question: `expandSrnTarget` enumerates every pattern that could cover the target
— at most twenty strings — and tests array overlap. The equivalence is asserted against the whole
cross-language fixture file; see the [`@lib/srn` README](../../../../lib/typescript/srn/README.md).

The organization segment of that SRN **always comes from `c.var.organization.id`**, never from
request input. A `resourceFor` selector returns only `{ service, type, id }`; `requirePermission`
supplies the tenant. A selector that could name its own organization would let a caller who
legitimately belongs to one team be authorized against another.

### Never ask "has all of these" with a single `@>`

Postgres evaluates array containment **per row**. A member holding `project:create` through one role
and `project:delete` through another has them on two rows, and
`actions @> ARRAY['project:create','project:delete']` matches neither — the query reports "no" for a
member who genuinely holds both. Union semantics need aggregation across rows: either `bool_or` in
SQL, or `matchingGrants` plus `actionsCover` in application code. There is a test that fails if this
is ever "simplified" back to `@>`.

## `member_permission` is a cache with exactly one invalidation rule

It is a denormalization of `role_statement` × `member_role`, and it is what actually authorizes
requests. `member_permission.member_role_id ON DELETE CASCADE` covers a _revoked assignment_ and
nothing else. **Editing a statement in place touches no `member_role` row**, so the stale copy keeps
authorizing under the old rules.

Therefore: `crudMemberPermission(tx).rebuildOrganization(organizationId)` runs **in the same
transaction** as any role creation, statement edit, role deletion, assignment change, invite
acceptance, or ownership transfer. `src/rbac/rbac.test.ts` asserts the stale state explicitly, so
the rebuild can never be dropped as redundant.

## `requirePermission(action, resourceFor)`

```ts
const app = new Hono()
  .use(authMiddleware)
  .delete(
    "/:orgSlug/roles/:roleId",
    validator("param", roleIdParam),
    requirePermission("role:delete", paramResource("org", "role", "roleId")),
    async (c) => {
      const organization = c.var.organization // resolved, existing, live
      const membership = c.var.membership // the caller's, active
    },
  )
```

It composes on top of `authMiddleware` rather than replacing it: it reads `c.var.user` and would
throw without it. In order it resolves the organization, checks membership, builds the SRN,
evaluates, and sets `c.var.organization` and `c.var.membership`.

**Organization resolution.** `/orgs/:orgSlug/…` per ADR 0003; the slug in the path wins. A request
without one falls back to `user_preference.last_org_id`, joined against live membership so a
pointer left behind by a removal resolves to nothing. Tenancy is never read from a cookie: two tabs
on two teams would become impossible and every request would be a confused deputy.

**Status codes are deliberately asymmetric.**

| Situation                                    | Status |
| -------------------------------------------- | ------ |
| Organization does not exist                  | 404    |
| Organization exists, caller is not a member  | 404    |
| Organization exists, membership is suspended | 404    |
| Caller is a member but lacks the action      | 403    |
| Caller is a member, a deny statement matches | 403    |

The first three are identical on purpose. A 403 for a real team would let a stranger enumerate
which slugs exist and who belongs to them; a member who gets a 403 learns nothing they did not
already know.

**Resource ownership is still the handler's job.** The middleware authorizes _an action against an
SRN_, and it builds that SRN from the resolved organization plus a path parameter it does not
verify. A role id belonging to another organization produces a well-formed SRN in _this_
organization and passes the check. Every `fetch*` in the DAO therefore takes the organization id
alongside the resource id — `getInOrganization`, not `getOne` — so a foreign id resolves to
`undefined` and the handler 404s.

## Routes

Mounted from `src/v1/index.ts`. Every mutation writes an `audit_log` row inside the same
transaction as the mutation.

| Method | Path                                        | Action                   |
| ------ | ------------------------------------------- | ------------------------ |
| GET    | `/v1/orgs`                                  | — (membership only)      |
| POST   | `/v1/orgs`                                  | — (any signed-in user)   |
| GET    | `/v1/orgs/:orgSlug`                         | `org:read`               |
| PATCH  | `/v1/orgs/:orgSlug`                         | `org:update`             |
| DELETE | `/v1/orgs/:orgSlug`                         | `org:delete` (soft)      |
| POST   | `/v1/orgs/:orgSlug/transfer-ownership`      | `org:transfer_ownership` |
| GET    | `/v1/orgs/:orgSlug/members`                 | `member:read`            |
| PUT    | `/v1/orgs/:orgSlug/members/:memberId/roles` | `member:update`          |
| DELETE | `/v1/orgs/:orgSlug/members/:memberId`       | `member:remove`          |
| DELETE | `/v1/orgs/:orgSlug/leave`                   | — (membership only)      |
| GET    | `/v1/orgs/:orgSlug/invites`                 | `member:read`            |
| POST   | `/v1/orgs/:orgSlug/invites`                 | `member:invite`          |
| DELETE | `/v1/orgs/:orgSlug/invites/:inviteId`       | `member:invite`          |
| POST   | `/v1/invites/accept`                        | — (the token authorizes) |
| GET    | `/v1/orgs/:orgSlug/roles`                   | `role:read`              |
| GET    | `/v1/orgs/:orgSlug/roles/actions`           | `role:read`              |
| POST   | `/v1/orgs/:orgSlug/roles`                   | `role:create`            |
| PATCH  | `/v1/orgs/:orgSlug/roles/:roleId`           | `role:update`            |
| DELETE | `/v1/orgs/:orgSlug/roles/:roleId`           | `role:delete`            |
| GET    | `/v1/user/me/preferences`                   | — (the caller's own)     |

Lists are cursor-paginated through `src/utils/pagination.ts`.

`GET /v1/user/me/preferences` is what `/dashboard` redirects against. It returns
`last_org_id` as a **slug**, verified against live membership, and falls back deterministically —
the caller's personal organization first, then the oldest team they belong to — when the pointer
is null or stale. Without it the redirect lands on whichever organization happens to sort first,
so a user with three teams does not reliably return to the one they were last in (ADR 0004).

### Leaving is membership, not permission

`DELETE /v1/orgs/:orgSlug/leave` takes **no action and evaluates no policy**. Any active member may
always leave; being unable to walk out of a team someone invited you to is a trap, not a security
property. It uses `requireMembership()` — the organization is resolved and active membership is
asserted with the same 404-never-leaks rule, and nothing else is checked.

There is deliberately **no `member:remove_self` action**. An action no route evaluates would let a
custom role carry a `deny member:remove_self` that silently does nothing, which is exactly the lie
the catalogue exists to prevent. The absence of a check is the honest encoding of "any member,
always". The audit row's action string is `member:leave`; `audit_log.action` is free text and
already carries non-catalogue strings such as `member:invite:accept`.

Two refusals, both **409**, both structural rather than authorization — a 403 would misdescribe
them:

- **A personal organization cannot be left.** It is the user's default and the thing `last_org_id`
  falls back to, so leaving would strand them with nowhere to land.
- **The owner cannot leave.** `organization.owner_user_id` is `ON DELETE RESTRICT` against a member
  row that would no longer exist, and an organization whose owner is absent from the member list is
  a state no screen can render. They transfer ownership or delete the organization; the error names
  both.

Personal is checked first, because a personal organization is always owned by its user, so both
rules fire at once and "you cannot leave your personal team" is the more actionable message.

On success the membership is deleted (cascading `member_role`, then `member_permission`), the
denormalization is rebuilt anyway to keep that rule unconditional, and `last_org_id` is repointed
if it named the organization being left. The response carries `nextOrganizationId` so the dashboard
knows where to send them instead of guessing.

**The path is `/leave`, not `/members/me`.** `RegExpRouter` cannot hold a static segment and a
parameter at the same position for the same method, so `DELETE /members/me` collides with
`DELETE /members/:memberId` and throws `UnsupportedPathError` at startup. (`GET /roles/actions`
coexists with `PATCH /roles/:roleId` only because they are different methods.) Folding self-removal
into the `:memberId` route was the other option, but it would demote that route's
`requirePermission("member:remove")` to a check buried in the handler, and the gate on these routes
should stay visible in the route definition.
The store and project-lifecycle routes that build on `requirePermission` are documented separately in [`STORE-AND-PROJECTS.md`](STORE-AND-PROJECTS.md).

### Rules the routes enforce that the schema cannot

- **The owner role is not grantable.** `PUT …/members/:id/roles` refuses to add it and refuses to
  strip it from the current owner. If it were assignable, `member:update` would be a path to
  `org:delete` for anyone holding it — precisely the authority the admin role's deny statement
  exists to withhold. Ownership moves only through `transfer-ownership`, which requires the
  incoming owner to already be an active member and demotes the outgoing owner to `admin`.
- **The owner cannot be removed** while they own the organization, by anyone including themselves.
- **System roles cannot be edited, deleted, or shadowed by name.**
- **A role that anyone still holds cannot be deleted** (409). `member_role` cascades from `role`,
  so deleting an assigned role would silently strip permissions from everyone holding it.
- **Custom statements are validated** against the catalogue and must carry SRNs scoped to this
  organization. A foreign organization segment is already inert — the query filters
  `member_permission.organization_id` — but storing one is a trap for the first query that stops.
- **Invites are bound to the address they were sent to.** Only the SHA-256 of the token is stored,
  the raw token is returned exactly once at creation, redemption is a conditional update so a
  double redemption creates one membership, and invites expire after seven days.
- **Slugs** are checked against a reserved-word denylist (ADR 0003) and disambiguated with a
  numeric suffix. The uniqueness index is partial on `deleted_at IS NULL`, so a soft-deleted
  organization releases its name.

## Sign-in provisioning

`provisionOrganization(db).ensureDefaultOrganization({ userId, name, email })` is what the OAuth
callback calls, on every sign-in rather than only the first. A user who already belongs to a live
organization gets it back with `created: false` and no rows are written; otherwise it creates
`"<Name>'s Team"` (`kind: 'personal'`), seeds the three system roles, makes the user the owner,
rebuilds `member_permission`, points `user_preference.last_org_id` at it, and audits — in one
transaction.

`createOrganization` is the same path for additional teams (`kind: 'team'`, no cap).

The system role definitions live in `@lib/dao` `role/systemRoles.ts`, which is the runtime twin of
`apps/dbmigrator/src/lib/system-roles.ts`. `src/rbac/rbac.test.ts` imports both and asserts they are
identical — an organization created at sign-in and one backfilled by the `0006_system_roles` seed
must have byte-identical statements, or a team's authority would depend on when it was created.

## Tests

`src/rbac/rbac.test.ts` and `src/v1/*.test.ts` run against the compose Postgres, and skip when it is
unreachable. Authorization is a property of the schema — the GIN index, the cascades, the partial
unique index, `bool_or` over rows from two different roles — so a mocked database would test the
mock.
