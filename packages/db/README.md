# @sproutos/db

This package provides a database client for the project. This is also where code generation occurs.

## Commands

To generate types for Kysely, run

`pnpm run db-codegen`

## .env

```.env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/main?schema=public"
```

## Regenerating types

```bash
pnpm --filter=@sproutos/db run db-codegen
```

Requires the docker-compose Postgres up and migrated. The script formats afterwards, because
kysely-codegen emits semicolons and this repo does not — without that step every regeneration
produces a diff made entirely of punctuation.

### Why the config is `.cjs`

kysely-codegen loads its config through cosmiconfig's **synchronous** explorer. Given a `.ts`
config, cosmiconfig reaches for the TypeScript compiler API and calls `typescript.findConfigFile`,
which **TypeScript 7 removed** — the same TS 6/7 split that forced `tools/openapi` into its own
workspace. A `.cjs` config is loaded by plain `require`, so no compiler is involved.

`.mjs` is not an option: the synchronous explorer cannot `await import()`.
