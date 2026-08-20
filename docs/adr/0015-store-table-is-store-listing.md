# 0015. The store table is `store_listing`

- Status: Accepted
- Date: 2026-08-20

## Context

A straightforward dangling foreign key, caught by the completeness critique.

The store notes create `store_listing` — with `store_listing_tag`, `store_listing_screenshot`, and
`store_listing_event` alongside it — as the catalogue entry for a forkable open-source project.

The projects notes reference a different name: "`store_app_id | uuid | null fk **store_app**`". No
area creates a table called `store_app`.

Written as designed, the init migration fails at `project`. Written carelessly — with the FK
omitted "for now" — it produces an unconstrained uuid column that will silently hold garbage.

## Decision

The table is `store_listing`. The column on `project` is `store_listing_id uuid NULL REFERENCES
store_listing(id) ON DELETE SET NULL`. `store_app` does not exist anywhere in the schema, the DAOs,
or the API surface.

## Consequences

- DAO paths follow the table name: `lib/typescript/dao/src/storeListing/{crud,fetch}.ts`, exporting
  `crudStoreListing` / `fetchStoreListing`, per the `dao-creator` convention.
- `ON DELETE SET NULL` rather than `RESTRICT`: archiving a listing must not be blocked by projects
  forked from it, and a project whose origin listing is gone is still a perfectly good project. It
  loses its provenance link, which is display metadata, not billing data.
- The listing is the _catalogue entry_, not the repository. A forked project's git identity lives on
  `repository` (`upstream_github_repo_id`, `provenance`), so upstream tracking survives the listing
  being unpublished.
- `store_listing.platform` is a Postgres enum from day one, populated only with `'web'`. TASK 18's
  Android/iOS/Windows/macOS/Linux additions become `ALTER TYPE … ADD VALUE` plus a filter facet — but
  note that `ALTER TYPE … ADD VALUE` cannot run inside a transaction block, so that migration must be
  written accordingly, and `db-codegen` re-run because kysely-codegen bakes enum unions into
  `types.ts`.
- Slugs are constrained to `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$` with no dots. `isAssetRequest()` in
  `proxy.ts` treats any path ending in `.\w+` as an asset and would skip the SPA rewrite, 404ing a
  slug like `next.js-starter` for logged-in users. A `proxy.test.ts` case covers `/store/foo.bar`.

## Alternatives considered

**Rename `store_listing` to `store_app`.** Fewer characters, and "app" matches the product language
("app store of forkable open-source projects"). Rejected: the store area designed four tables around
the `store_listing_` prefix, and "listing" is the more accurate noun — the row is the catalogue entry
describing an app, not the app.

**Drop the FK and keep a loose id.** Rejected: an unconstrained uuid column is exactly how the
critique found this bug in the first place.
