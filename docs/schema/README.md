# Database schema

## What lives here

- **[`TABLES.md`](TABLES.md)** — the consolidated table inventory. All 81 tables with their owning
  area, purpose, and FK edges; the single FK-dependency creation order the init migration is written
  from; the naming collisions and dangling FKs that were resolved to produce it; and the tables the
  plan explicitly defers.

That document is the reference, not the truth. The truth is
`apps/dbmigrator/src/migrations/` and the types generated from it into `packages/db/src/types.ts`.
When they diverge, the migration wins and `TABLES.md` gets fixed.

The decisions that shaped the schema — the tenancy noun, the store table name, soft-delete
semantics, the RBAC grammar — are recorded in [`../adr/`](../adr/README.md). The raw pre-decision
research is `private_notes/PLANNING_INITIAL_NOTES.md`, which is a scratchpad and contains claims that
turned out to be wrong.

## Adding a table

1. **Write the DAOs first, or at least alongside.** Follow `.claude/skills/dao-creator`:
   `lib/typescript/dao/src/<camelCaseTableName>/crud.ts` and `fetch.ts`, exporting
   `crud<PascalName>(db)` and `fetch<PascalName>(db)`, both re-exported from
   `lib/typescript/dao/src/index.ts`. Fetch functions take an explicit `fields` array so the return
   type narrows; call the factory inline in handlers, never into a variable.

2. **Create the migration.**

   ```bash
   cd apps/dbmigrator/src && pnpm dlx kysely migrate:make <name>
   ```

   Note the upstream `getMigrationPrefix` month-off-by-one when reading filenames.

3. **Apply it and regenerate types.**

   ```bash
   docker compose up -d
   pnpm --filter=dbmigrator run migrate:latest
   pnpm --filter=@sproutos/db run db-codegen
   ```

   Commit the regenerated `packages/db/src/types.ts` in the same change as the migration. A codegen
   diff that lands separately is how the two drift.

4. **Prove it reverses.** `migrate:down` must undo it cleanly. This is the check that catches a
   circular FK or a dangling reference, and it is part of the verification pass on every phase.

5. **Add a row to [`TABLES.md`](TABLES.md)** — the summary table, the area section, and the
   ordering list. If durable billing or audit history references the new table, it needs
   `deleted_at` and its inbound history FKs are `ON DELETE RESTRICT`
   ([ADR 0017](../adr/0017-soft-delete-on-billing-referenced-tables.md)).

## snake_case in migrations, camelCase in code

Migrations, seeds, and raw SQL use **snake_case**: `organization_id`, `created_at`,
`store_listing_id`. Application code — DAOs, handlers, serializers, the SPAs — uses **camelCase**:
`organizationId`, `createdAt`, `storeListingId`.

Nobody translates by hand. Kysely's `CamelCasePlugin`, registered on the client in
`packages/db/src/index.ts`, converts in both directions: it maps camelCase identifiers in your query
builder down to snake_case on the wire, and maps result columns back up. `kysely-codegen` reads the
real database and emits the camelCase types, so `DB["storeListing"]["storeListingId"]` is what
TypeScript sees and `store_listing.store_listing_id` is what Postgres sees.

Two consequences worth knowing before they bite:

- **Raw SQL bypasses the plugin.** Anything inside a `sql` template literal — a generated column expression, a
  trigger body, an index predicate, a `CHECK` constraint — must be written in snake_case, including
  in migrations that otherwise look like TypeScript.
- **Table names follow the same rule.** The table is `store_listing`; the DAO directory is
  `lib/typescript/dao/src/storeListing/`; the type key is `DB["storeListing"]`.

## Local database

`docker-compose.yaml` runs Postgres 18 on host port **25281** (SproutOS's own port block — the
waiting-list repo uses 25271 and the upstream scaffold uses 24313, and all three must be able to run
side by side). The database is `main`, not `postgres`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:25281/main?schema=public
```

Do not put `sslmode` in the URL. It overrides the TLS configuration in `packages/db/src/index.ts`.
