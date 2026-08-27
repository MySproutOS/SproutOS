# dbmigrator

Kysely migrations and seeds for the SproutOS control-plane database. This is the **only** place the
schema is defined; `packages/db/src/types.ts` is generated from a live database that this package
built, and `docs/schema/TABLES.md` is a reference that follows the migration rather than leading it.

## Commands

Every `kysely` command needs `--cwd src`, which the package scripts already pass.

```bash
docker compose up -d                                # Postgres 18 on host port 25281
pnpm --filter=dbmigrator run migrate:latest         # apply everything outstanding
pnpm --filter=dbmigrator run migrate:down           # reverse the most recent migration
pnpm --filter=dbmigrator run migrate:up             # apply exactly one
pnpm --filter=dbmigrator run seed:run               # run every seed, in filename order
pnpm --filter=@sproutos/db run db-codegen           # regenerate packages/db/src/types.ts
```

## Migrating on deploy

`migrate:latest` is the command for a developer at a terminal. `migrate:deploy` is the one a
deployment runs, and the difference is a Postgres advisory lock.

```bash
pnpm --filter=dbmigrator run migrate:deploy      # takes a lock, applies, releases, exits non-zero on failure
```

A rollout starts N pods at once and every one of them wants the schema current. Left alone they
race: two `create table` statements collide and one pod crash-loops, or — worse — two data
migrations both run and the second operates on rows the first already moved. Kysely's migration
table has a unique constraint, which turns the first case into an error rather than corruption, but
an error at boot is still a failed rollout and it does nothing about the second.

The lock lives in the database being migrated, which is the point. A Kubernetes lease or a flag in
Redis puts the coordination somewhere other than the resource being coordinated, and then a network
partition gets you two holders of a lock protecting one database.

Three details that are easy to get wrong and are commented where they live:

- The lock is taken on a **pinned** connection (`db.connection()`). `pg_advisory_lock` is
  session-scoped, so taking it through the pool acquires it on whichever connection came free and
  releases it on whichever comes free next — which is to say, releases somebody else's.
- It is released in a `finally`, because a pooled connection returns to the pool rather than
  closing, and one still holding an advisory lock hands that lock to whatever runs on it next.
- The key is a hard-coded constant, not `hashtext('…')`. `hashtext` is internal and its output has
  changed between major versions, so a computed key would differ between a pod on the old version
  and a pod on the new one — exactly when two migrators must not both think they hold the lock.

`deploy.test.ts` proves the exclusion by _being_ the first process: it takes the lock on its own
connection and requires `deploy` to fail with `55P03` rather than proceed. Racing two real migrators
would not prove it — process startup staggers them by more than a migration takes, so the unlocked
version passes such a test almost every time, which is how a missing lock survives review and turns
up on a rollout at scale instead.

`migrate:latest` → `migrate:down` → `migrate:latest` is the real structural test. It is what catches
the circular foreign key, a dangling reference, and any ordering mistake, and it must pass before a
schema change is proposed. `down()` deliberately does **not** use `CASCADE`: if the reverse order is
wrong, the drop fails, which is the point.

> **Known breakage:** `db-codegen` currently fails to load `packages/db/.config/.kysely-codegenrc.ts`.
> cosmiconfig loads `.ts` config through the TypeScript compiler API and calls
> `typescript.findConfigFile`, which TypeScript 7 no longer exposes — the same TS6/TS7 split that
> forced `tools/openapi` into its own workspace. Until the config is ported, generate with flags:
>
> ```bash
> cd packages/db && pnpm exec kysely-codegen \
>   --dialect postgres --env-file ../../.env --camel-case --out-file ./src/types.ts
> ```
>
> Then run `pnpm exec oxfmt --config oxfmt.config.mts packages/db/src/types.ts`, because
> kysely-codegen emits semicolons and the repo does not. Commit `types.ts` in the same change as the
> migration; a codegen diff that lands separately is how the two drift.
>
> For the same reason, `kysely-codegen --verify` always reports a diff against the committed file —
> it compares byte-for-byte against unformatted output. It is not a usable freshness check here.

## The ordering rule

`2026_08_20_00_00_00_init.ts` creates all 81 tables in one file, in a single foreign-key-valid order.
That order is duplicated in the module-level `TABLE_ORDER` array, and `down()` walks it backwards.

Two rules follow from that, and both matter:

1. **A table is created after every table it references.** New tables go at the end of `up()` in a
   new migration, not spliced into the init migration.
2. **`TABLE_ORDER` and the creation order in `up()` must stay in the same sequence.** They are the
   same list written twice; the up/down/up cycle is what proves they still agree.

## The circular foreign key

`workflow.current_version_id → workflow_version.id` and `workflow_version.workflow_id → workflow.id`
is the only genuine cycle in the schema. It is broken in three steps:

1. `workflow` is created with `current_version_id uuid` — nullable, **no constraint**.
2. `workflow_version` is created normally.
3. A raw `sql` statement adds the constraint:

```ts
await sql`
  alter table workflow add constraint workflow_current_version_id_fkey
    foreign key (current_version_id) references workflow_version (id) on delete set null
`.execute(db)
```

`down()` drops that constraint **first**, before the table loop reaches `workflow_version`.

`DEFERRABLE INITIALLY DEFERRED` would also work and was considered. `ALTER TABLE` wins because it
keeps normal inserts on immediate constraint checking, and because a deferred constraint fails at
`COMMIT`, where the error is much harder to attribute to the statement that caused it.

Use the same technique for any future cycle. Do not reach for a nullable uuid with no constraint at
all — an unconstrained id column silently holds garbage.

## Enum-like columns: CHECK constraints, not Postgres enums

**Every** enum-like column in this schema is `text` plus a named `CHECK` constraint. There are no
`CREATE TYPE ... AS ENUM` statements, including for the six that `docs/schema/TABLES.md` step 2 names
(`store_platform`, `store_listing_status`, `store_listing_event_kind`, `usage_dimension`,
`credit_account_kind`, `credit_transaction_kind`). Three reasons:

- **One approach, applied consistently.** There are roughly sixty enum-like columns. Native types for
  six of them and CHECK constraints for the rest is the worst of both — a reader has to know which
  vocabulary lives where.
- **Vocabularies churn, and enum values can never be removed.** Postgres has no way to drop a value
  from an enum type — not in a migration, not ever. A job-state or deployment-status vocabulary that
  gains and loses values over a greenfield year would accumulate dead values permanently. Editing a
  CHECK is `DROP CONSTRAINT` + `ADD CONSTRAINT` in one ordinary transactional migration.
- **`down()` stays a pure table-drop reversal.** No orphan types to clean up separately, which is
  exactly the class of leftover the up/down/up cycle exists to catch.

The cost is real and worth naming: kysely-codegen emits `string` for a CHECK column where it would
emit a string union for a native enum. The vocabularies therefore need a TypeScript home — the same
place the [ADR 0016](../../docs/adr/0016-one-rbac-action-catalogue.md) action catalogue lives — and
the API layer must narrow at its boundary. The database is the backstop, not the type system.

Constraints are named `<table>_<column>_check` so a violation names the column in the error.

## The envelope convention

No plaintext secret column exists anywhere in this schema. Every encrypted field is exactly three
`text` columns, per [`@lib/envelope`](../../lib/typescript/envelope/README.md):

| column                | holds                                                   |
| --------------------- | ------------------------------------------------------- |
| `{field}_ciphertext`  | base64 of `IV ‖ ciphertext ‖ auth tag`                  |
| `{field}_wrapped_dek` | base64 of the data key, encrypted under the CMK         |
| `{field}_kms_key_id`  | which CMK wrapped it, so rotation knows what to re-wrap |

Columns using it: `account.access_token_*` and `account.refresh_token_*`, `agent_credential.secret_*`,
`project_env_var.value_*`, `database_role.password_*`, `cache_namespace.acl_password_*`,
`oauth_signing_key.private_key_*`.

Deliberately **not** enveloped, because they are hashes and are never decrypted:
`session.session_key`, `organization_invite.token_hash`, `oauth_access_token.token_hash`,
`oauth_refresh_token.token_hash`, `oauth_authorization_code.code_hash`,
`observability_stream.otlp_ingest_key_hash` (sha256 hex), and `oauth_client_secret.secret_hash`
(argon2id).

## Money

Money **amounts** are `bigint` micro-USD. Never floating point, never `numeric`, never cents.

Unit **rates** — `price_book_item.unit_micro_usd` and `statement_line_item.unit_micro_usd` — are
`numeric(38, 9)`, which is exact decimal, not floating point. A `bigint` micro-USD cannot express
$0.30 per million cache-read tokens (0.3 µUSD per token) or $0.15/GiB of egress (0.00014 µUSD per
byte); both would round to zero and bill nothing. Rating multiplies `quantity × unit_micro_usd` and
rounds the **product** to whole micro-USD at the hour boundary, never per event.

## Soft delete and partial uniques

Anything durable billing or audit history references is soft-deleted, per
[ADR 0017](../../docs/adr/0017-soft-delete-on-billing-referenced-tables.md). A hard delete would
destroy the history that justifies charges already made.

`deleted_at timestamptz NULL` on: `user`, `organization`, `project`, `repository`,
`github_installation`, `store_listing`, `agent_credential`, `backend_service`, `database_instance`,
`deployment`, `workflow`.

Inbound foreign keys from billing and audit tables are `ON DELETE RESTRICT`, so no cascade can reach
a row the ledger points at. Uniqueness that must be reusable after deletion is a **partial unique
index** rather than a constraint, because a constraint cannot carry a predicate:

```
organization_slug_live_key            on organization (slug)                        where deleted_at is null
project_org_slug_live_key             on project (organization_id, slug)            where deleted_at is null
workflow_project_slug_live_key        on workflow (project_id, slug)                where deleted_at is null
repository_org_github_repo_live_key   on repository (organization_id, github_repo_id) where deleted_at is null
store_listing_slug_live_key           on store_listing (slug)                       where deleted_at is null
agent_credential_label_live_key       on agent_credential (organization_id, label)  where deleted_at is null
```

Every DAO `fetch*` must filter `deleted_at IS NULL` by default. Forgetting it in one DAO leaks
deleted rows into a UI, which is why the filter belongs in the DAO layer rather than each handler.

## Append-only tables

Three tables are append-only, enforced in the database rather than by convention:

- **`audit_log`** and **`workflow_job_edit_audit`** — a `BEFORE UPDATE OR DELETE` trigger running
  `sproutos_append_only()` raises an exception naming the table and the operation.
- **`credit_ledger_entry`** — `sproutos_ledger_entry_guard()` blocks `DELETE` outright and permits
  exactly one `UPDATE`: setting `compacted_at` from `NULL`, once. Every other column is asserted
  unchanged. See the balance section below for why that one update exists.

A deferred constraint trigger, `credit_ledger_entry_balanced`, asserts at `COMMIT` that every
`credit_transaction`'s legs sum to zero. It must be deferred: the legs of a transaction are inserted
as separate rows, so the invariant is only true at the end of the statement group.

**Because the triggers are absolute, so is the consequence:** an `audit_log` row can never be deleted
by application code, which means an `organization` referenced by one can never be hard-deleted
either. That is intentional. Retention and GDPR erasure are a privileged, out-of-band path that
disables the trigger for the purge window:

```sql
begin;
set local session_replication_role = 'replica';
delete from audit_log where organization_id = $1;
commit;
```

That requires a superuser or table owner, which is exactly the authorization level purging audit
history should need. Do not weaken the trigger to make an ordinary job's life easier.

## The balance cache is commit-ordered

`credit_balance_cache` holds a checkpoint; the balance is `cache.balance_micro_usd` plus the sum of
`credit_ledger_entry` rows where `compacted_at IS NULL`. There is never a mutable balance column.

The research proposed `seq bigint GENERATED ALWAYS AS IDENTITY` with a read path of
`cache.balance + SUM(seq > as_of_seq)`. That is wrong and loses money: identity values are allocated
at `INSERT`, not `COMMIT`, so a transaction that takes seq 100 and commits after the holder of 101 is
skipped permanently once the compactor passes 101 — under-counting spend.

The `compacted_at` flag makes the checkpoint commit-ordered by construction. The compactor can only
fold in a row it can actually see, and a late-committing transaction's row simply stays uncompacted
until the next pass. `seq` survives for stable pagination of the ledger UI, and for nothing else.

## Raw metering storage

Postgres no longer stores raw usage. The init migration's daily `usage_event` partitions had a
fixed creation window and therefore an expiry date. ADR 0028 moved acknowledged raw events to
Kafka and ClickHouse; Postgres now holds only `metering_outbox`, `metering_import_state`, absolute
`usage_rollup` grains, and ledger state.

## Seeds

`src/seeds/` runs in filename order via `pnpm --filter=dbmigrator run seed:run`. Every seed is
idempotent and safe to re-run.

| seed                     | what it establishes                                                                |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `0001_price_book.ts`     | Price book v2, 12% default fee, and per-dimension provider rates and fee overrides |
| `0002_region.ts`         | `us-east-1` active, `us-west-2` and `eu-west-1` inactive                           |
| `0003_store_category.ts` | The five catalogue facets                                                          |
| `0004_store_listing.ts`  | Six published listings with tags                                                   |
| `0005_dev_fixture.ts`    | Dev user, organization, repository, project — skipped when `NODE_ENV=production`   |
| `0006_system_roles.ts`   | `owner` / `admin` / `member` for every organization, plus `member_permission`      |

**`0001` is not optional.** Without a price book, rating resolves no unit price and silently produces
zero-cost usage. That is the most dangerous missing seed in the project: nothing fails, no error is
logged, and the bill is simply wrong.

`0006` is a re-runnable backfill, not just a bootstrap: it rewrites the system roles' statements from
`src/lib/system-roles.ts`, ensures the owner's membership holds `owner`, and rebuilds
`member_permission` for the organization from `member_role × role_statement`. Edit the role
definitions there and re-run it. Note that the application must do the same rebuild inside the
transaction that mutates a role, a statement, or an assignment — `member_role_id ON DELETE CASCADE`
handles deletions but **not** statement edits.

Resources in system-role statements are org-scoped SRNs (`srn:sproutos:*:<org_id>:*`), not the bare
`*`. A per-organization role that grants `*` across every organization is a tenancy bug.

`src/lib/` holds helpers the seeds share (`uuidV7`, row readers, the role catalogue). It sits outside
`src/migrations/` and `src/seeds/` deliberately — both of those folders are scanned wholesale by
kysely-ctl, so anything dropped in them is treated as a migration or a seed.

## Adding a table

1. **Write the DAOs alongside**, per `.claude/skills/dao-creator`:
   `lib/typescript/dao/src/<camelCaseTableName>/{crud,fetch}.ts`, re-exported from `src/index.ts`.
2. **Create the migration**, and note the upstream `getMigrationPrefix` month-off-by-one when you
   read the generated filename:

   ```bash
   cd apps/dbmigrator/src && pnpm dlx kysely migrate:make <name>
   ```

3. **Follow the conventions.** `uuid` primary key, app-supplied UUIDv7, never a DB default.
   `timestamptz` for time, `created_at` defaulting to `now()`. `bigint` micro-USD for money.
   snake_case everywhere — including inside `sql` template literals, which bypass `CamelCasePlugin`
   entirely. An index on every foreign-key column. A named `CHECK` for every enum-like column.
4. **Decide the delete semantics.** If `usage_event` can reach the new table, it needs `deleted_at`
   and its inbound billing foreign keys are `ON DELETE RESTRICT`. If it has an append-only trigger,
   nothing may `CASCADE` or `SET NULL` into it — the trigger will block the cascade and make the
   parent undeletable.
5. **Apply, reverse, re-apply, regenerate types**, then commit `packages/db/src/types.ts` with the
   migration.
6. **Add a row to [`docs/schema/TABLES.md`](../../docs/schema/TABLES.md)** — the summary table, the
   area section, and the ordering list.
