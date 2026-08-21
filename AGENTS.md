# SproutOS

SproutOS lets people cost-effectively create and deploy database-backed workflows and
auth-backed sites without knowing how to code.

See `README.md` for what the product does. This file covers the repository.

## Build Commands

```bash
# Install dependencies
pnpm install

# Start everything (website 3000, API 3001, dashboard 3002, admin 3003)
pnpm run dev

# Or start apps individually
pnpm run dev --filter=website         # Next.js
pnpm run dev --filter=@api/internal   # Hono API (API_PORT)
pnpm run dev --filter=dashboard       # Dashboard SPA
pnpm run dev --filter=admin           # Admin SPA

# Tests, lint, format
pnpm test
pnpm run lint          # Oxlint with auto-fix, config at oxlint.config.mts
pnpm run format        # Oxfmt, config at oxfmt.config.mts

# Local services: Postgres 25281, Valkey 41023, LocalStack 4566
docker compose up -d
bin/bootstrap-localstack.sh                        # create the dev KMS CMK, buckets, SES identity

# Database
pnpm --filter=dbmigrator run migrate:latest
pnpm --filter=@sproutos/db run db-codegen          # regenerate Kysely types
cd apps/dbmigrator/src && pnpm dlx kysely migrate:make <name>

# Typed API client (needs the API running on 3001)
pnpm --filter=@lib/api-client run openapi          # public API -> src/generated
pnpm --filter=@lib/api-client run openapi:admin    # admin API  -> src/admin-generated

# Rust services
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test
cargo build --release --target aarch64-unknown-linux-musl
```

## Architecture

A polyglot monorepo: pnpm workspaces for TypeScript, one Cargo workspace for Rust.

### The language boundary

**Rust for anything on a per-packet, per-connection, or per-sample hot path. TypeScript for
the control plane, the API, and every UI.** A process that wakes 1 Hz per pod on every metal
node, or sits between a tenant's queue client and Valkey on every command, should not be
paying for a GC and an event-loop hop.

### Apps (TypeScript, deployed)

- `apps/website` — Next.js. SEO pages, the OAuth login flow, and `src/proxy.ts`.
- `apps/internal-api` — Hono API with TypeBox schemas and OpenAPI generation. **A separate
  deployment**, not mounted inside Next.js: it serves `/v1/*` and `/admin/*` from its own host
  (`localhost:3001` in dev, `api.<domain>` in production).
- `apps/frontends/dashboard` — React SPA (Vite + TanStack Router). Requires authentication.
- `apps/frontends/admin` — React SPA. Requires authentication + `is_admin`.
- `apps/dbmigrator` — Kysely migrations.

### Services (Rust, deployed)

- `services/metering-agent` — cgroup v2 sampler. One VM may host several projects, so samples carry
  a `project_id` split key rather than assuming one pod is one tenant. The parsing, deltas,
  idempotency keys and retry buffer are pure and tested on any platform; only the reads need Linux.
  **Pod discovery is not wired** — it reads an empty label map, so it runs and bills nothing until
  the DaemonSet gives it the kubelet's pod-resources socket.
- `services/pg-proxy` — Postgres wire proxy: tenant auth, routing into the tenant's database, and a
  `SET ROLE` that drops the proxy's own privilege before the session is spliced. Speaks SCRAM to the
  cluster, checked against RFC 7677's vector. **Wake-on-connect is not built** — there is no Neon
  control plane to wake.
- `services/valkey-proxy` — RESP proxy and master-queue dispatcher. Tenants point BullMQ or
  Celery at it as though it were Valkey.
- `services/search-proxy` — OpenSearch tenant-split proxy. Document- and field-level security
  is not in the OSS tier, so this proxy _is_ the security boundary.
- `services/storage-proxy` — S3 tenant-split proxy. Verifies a tenant's SigV4 signature against a
  secret _derived_ from one root key, checks the bucket in the path is theirs, and re-signs with the
  platform's credential. A customer never holds a cloud credential. Replaced a per-tenant IAM user,
  which capped the platform at 5,000 buckets and put the boundary in a policy document nothing here
  could test.

### Libraries

- `packages/db` — Kysely client and generated types (`@sproutos/db`).
- `lib/typescript/dao` — Data access objects (`@lib/dao`).
- `lib/typescript/api-client` — Hey-API generated client (`@lib/api-client`).
- `lib/typescript/oauth` — **Vendored** OAuth2 client (`@lib/oauth`). No arctic.
- `lib/typescript/utils/crypto` — **Vendored** encoding/hash/random (`@utils/crypto`). No oslo.
- `lib/typescript/ui/{base,seo-shared,spa-shared}` — shared components and theme.
- `lib/rust/{srn,metering-proto,tenant-auth,s3-sigv4,service-credentials}` — shared crates.
  `s3-sigv4` is SigV4 from the _verifying_ end, which no published crate exposes.

### The SPA split

`apps/website/src/proxy.ts` is the routing spine. Every request hits Next.js, which classifies
the path in this order:

1. **`SHARED_ROUTES`** — the same URL renders Next.js SSR when logged out (for SEO) and rewrites
   to the SPA when the `session` cookie validates. This is how `/store` is visible to both
   authenticated and unauthenticated visitors.
2. **`NEXTJS_PUBLIC_PREFIXES`** and exact `/` — Next.js SSR.
3. **`/admin*`** — admin SPA if authed, else redirect to `/login`.
4. **Everything else** — dashboard SPA if authed, else redirect to `/login`.

`matchRoute()` implements Next.js path conventions (`[param]`, `[...catchAll]`,
`[[...optionalCatchAll]]`). SPA route paths must mirror the patterns registered here.

Because the API is a separate origin, the session cookie is scoped with `cookieDomain()` and the
API sets CORS `credentials: true`. **Sessions store a hash of the token, never the token**, so a
database leak yields nothing replayable.

## Toolchain

`mise` pins **node** and **pnpm** only (`.config/mise.toml`). Rust is pinned by
`rust-toolchain.toml` through rustup, and Python tooling runs through **uv** — neither belongs in
mise. `Brewfile` carries `mise`, `rustup`, `uv`, `opentofu`, and `tflint`.

Any Python used for build or ops scripting runs as `uv run`; there is no project-level
`requirements.txt` or virtualenv to activate.

## Cross-language seams

Three contracts exist in both Rust and TypeScript. Each has one set of fixture vectors that both
sides assert against — a divergence in the first two is a security bug.

- **SRN grammar** (`lib/rust/srn` ↔ the TypeScript SRN module) — all three proxies authorize
  against it.
- **Metering event schema and HMAC signing** (`lib/rust/metering-proto` ↔ the ingest route).
- **Tenant credential parsing** (`lib/rust/tenant-auth` ↔ the control plane that issues them).
- **Object-storage secret derivation** (`lib/rust/s3-sigv4/src/tenant.rs` ↔ `lib/typescript/services`),
  vectors in `lib/rust/s3-sigv4/fixtures/tenant-secret.json`. A divergence here is loud rather than
  dangerous — a tenant who cannot authenticate at all — but only because both sides read the file.

## Conventions

In `.claude/skills/`: `dao-creator`, `hono-backend-api`, `frontend-calling-backend`,
`frontend-components`. Follow them.

Architectural decisions are recorded in `docs/adr/`. **`docs/findings/` is the companion**: things
that were wrong, how they looked while they were wrong, and what now stops them coming back. Read it
before adding a check — most of what is in there passed every check that existed at the time, and
the recurring lesson is that the question worth asking of a check is not whether it passes but what
would have to be true for it to fail.

Some load-bearing details those skills assume:

- Every table gets `lib/typescript/dao/src/<camelCaseTable>/{crud.ts,fetch.ts}`, re-exported from
  `src/index.ts`. Never call `db.selectFrom()` in a route handler; never assign a DAO to a
  variable — always `fetchThing(db).getOne(id, ["a", "b"])`.
- IDs are app-supplied UUIDv7 via `v7()`, not database-generated.
- Migrations use snake_case; `CamelCasePlugin` makes application code camelCase.
- SSE/streaming operations must be added to `parser.filters.operations.exclude` in the
  openapi-ts config — the generated client cannot handle streams.
- Money is never a mutable balance column. The credit ledger is append-only and double-entry.

## Environment

Copy `.template.env` to `.env`. Local development needs Docker; `DATABASE_URL` points at the
compose Postgres on **25281**.

LocalStack covers KMS, S3, Secrets Manager, SSM, Kinesis, and **SES v1** on its free Hobby plan —
which is why the mailer is written against `@aws-sdk/client-ses`, not `client-sesv2`. It reads
**`LOCALSTACK_AUTH_TOKEN`** and nothing else; a `LOCALSTACK_PAT` variable is silently ignored.
State does not persist across restarts on the free plan, so `bin/bootstrap-localstack.sh` is
idempotent and cheap to re-run. EKS, ECR, ALB, and CloudFront are **not** available locally at any
free tier — the deployment layer in `tofu/` is validated with `tofu validate` and `tflint`, not run.
