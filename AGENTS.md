## Build Commands

```bash
# Install dependencies
pnpm install

# Start everything (website 3000, API 3001, dashboard 3002, admin 3003)
pnpm run dev

# Or start apps individually
pnpm run dev --filter=website         # Next.js on port 3000
pnpm run dev --filter=@api/internal   # Hono API on port 3001 (API_PORT)
pnpm run dev --filter=dashboard       # Dashboard SPA on port 3002
pnpm run dev --filter=admin           # Admin SPA on port 3003

# Run all tests
pnpm test

# Run a single test file
npx vitest run path/to/file.test.ts --config .config/vitest.config.mts

# Lint and format
pnpm run format        # Oxfmt format with oxfmt.config.mts
pnpm run lint          # Oxlint check with auto-fix (oxlint.config.mts)

# Database
docker-compose up -d                              # Start PostgreSQL
pnpm run migrate:latest --workspace=dbmigrator     # Run migrations
pnpm run db-codegen --workspace=@queryme/db        # Generate Kysely types

# Create new migration
cd apps/dbmigrator/src && npx kysely migrate:make <name>

# Generate OpenAPI client (requires the API running on port 3001)
pnpm --filter=@lib/api-client run openapi         # public API  -> src/generated
pnpm --filter=@lib/api-client run openapi:admin   # admin API   -> src/admin-generated
```

## Architecture

This is a TypeScript monorepo with npm workspaces:

**Apps:**

- `apps/website` - Next.js frontend with Tailwind/ShadCN UI. Serves SEO pages and the OAuth login flow. Proxy (`src/proxy.ts`, formerly middleware) handles auth + rewrites for SPA routes
- `apps/internal-api` - Hono API with TypeBox schemas and OpenAPI generation. **A separate deployment**, not mounted inside Next.js: it serves `/v1/*` and `/admin/*` from its own host (`localhost:3001` in dev, `api.<domain>` in production)
- `apps/frontends/dashboard` - React SPA (Vite + TanStack Router) served at `/dashboard`. Requires authentication
- `apps/frontends/admin` - React SPA (Vite + TanStack Router) served at `/admin`. Requires authentication + is_admin
- `apps/dbmigrator` - Kysely database migrations

**Packages:**

- `packages/db` - Kysely database client and generated types (`@queryme/db`)
- `lib/typescript/dao` - Data access objects shared between API and website (`@lib/dao`)
- `lib/typescript/api-client` - Hey-API generated client code shared between website and SPAs (`@lib/api-client`)
- `lib/typescript/ui/components` - Shared ShadCN UI components and theme (`@ui/components`)
- `lib/typescript/utils/*` - Utility libraries (e.g., `@utils/numbers`)
