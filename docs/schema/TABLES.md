# SproutOS — consolidated table inventory

**81 tables.** This is the single reconciled view of a schema that was designed as ~72 tables across
thirteen research documents that never saw each other. It is the source the init migration is written
from.

Reconciling them turned up one genuine circular foreign key, four dangling ones, a table defined
twice with incompatible shapes, two parallel metering tables, and a tenancy column pointing at a
table that does not exist. Every one of those is resolved below under
[Conflicts resolved](#conflicts-resolved), applying the Phase 0 decisions in
[`../adr/`](../adr/README.md).

Column-level detail is **not** repeated here — the area notes in
`private_notes/PLANNING_INITIAL_NOTES.md` carry it. What this document owns is the complete set of
table names, who owns each one, its FK edges, and **one correct creation order**.

Conventions: migrations are snake_case; application code is camelCase via Kysely's `CamelCasePlugin`.
All ids are app-supplied UUIDv7 (`v7()`) unless noted. Timestamps are `timestamptz`. Money is
`bigint` micro-USD.

---

## Summary

| table                       | owning area    | purpose                                                                                        | FK targets                                                                   |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `user`                      | identity       | the person; scaffold table plus `github_login` / `github_user_id`                              | —                                                                            |
| `account`                   | identity       | OAuth App token custody, envelope-encrypted                                                    | `user`                                                                       |
| `session`                   | identity       | `session_key` = sha256(token); validated directly by `proxy.ts`                                | `user`                                                                       |
| `github_installation`       | identity       | GitHub App installation, org-scoped ([0007](../adr/0007-github-installation-is-org-scoped.md)) | `organization`, `user`                                                       |
| `organization`              | tenancy        | the tenant; `kind` ∈ personal, team ([0002](../adr/0002-tenancy-noun-is-organization.md))      | `user` (owner, RESTRICT)                                                     |
| `organization_member`       | tenancy        | membership + status                                                                            | `organization`, `user`                                                       |
| `role`                      | tenancy        | named policy set; `is_system` for the three seeded roles                                       | `organization`                                                               |
| `role_statement`            | tenancy        | IAM-shaped statement: `effect`, `actions[]`, `resources[]`                                     | `role`                                                                       |
| `member_role`               | tenancy        | role assignment                                                                                | `organization_member`, `role`                                                |
| `member_permission`         | tenancy        | denormalized hot path; rebuilt in the mutating transaction                                     | `organization`, `user`, `member_role`                                        |
| `organization_invite`       | tenancy        | email (citext) + sha256(token)                                                                 | `organization`, `role`, `user`                                               |
| `user_preference`           | tenancy        | `last_org_id`, sidebar collapse, pins ([0004](../adr/0004-last-org-in-user-preference.md))     | `user`, `organization`                                                       |
| `audit_log`                 | tenancy        | append-only; written in the same transaction as the mutation                                   | `organization`, `user`                                                       |
| `store_category`            | store          | filter facets                                                                                  | —                                                                            |
| `store_listing`             | store          | the catalogue entry ([0015](../adr/0015-store-table-is-store-listing.md))                      | `store_category`, `user` ×2                                                  |
| `store_listing_tag`         | store          | tags                                                                                           | `store_listing`                                                              |
| `store_listing_screenshot`  | store          | re-hosted screenshots, never hotlinked                                                         | `store_listing`                                                              |
| `store_listing_event`       | store          | view / visit / fork telemetry; drives `install_count`                                          | `store_listing`, `user`                                                      |
| `repository`                | projects       | git identity, provenance, upstream tracking                                                    | `organization`, `github_installation`                                        |
| `project`                   | projects       | the deployable unit; N:1 to `repository` (TASK 21)                                             | `organization`, `repository` (RESTRICT), `store_listing`, `agent_credential` |
| `project_env_var`           | projects       | env vars and runtime secrets, envelope-encrypted                                               | `project`                                                                    |
| `project_job`               | projects       | provision / fork / sync / delete, streamed over SSE                                            | `organization`, `project`, `repository`                                      |
| `upstream_sync_run`         | projects       | one per `(repository, branch)` upkeep pass                                                     | `repository`, `agent_job_run`                                                |
| `project_update_suggestion` | projects       | fan-out of one sync run to each project on the repo                                            | `project`, `upstream_sync_run`, `user`                                       |
| `agent_credential`          | agent          | BYO provider credential, envelope-encrypted                                                    | `organization`                                                               |
| `agent_config`              | agent          | org default, overridden per project                                                            | `organization`, `project`, `agent_credential`                                |
| `agent_session`             | agent          | one chat or upkeep session, with its DB branch                                                 | `project`, `user`, `database_branch`                                         |
| `agent_turn`                | agent          | one SDK `result` message                                                                       | `agent_session`                                                              |
| `agent_event`               | agent          | replayable SSE log; 30-day default TTL                                                         | `agent_session`, `agent_turn`                                                |
| `agent_session_entry`       | agent          | SDK transcript mirror for resume-after-eviction                                                | `agent_session`                                                              |
| `agent_job`                 | agent          | recurring upkeep / dev job definition                                                          | `project`                                                                    |
| `agent_job_run`             | agent          | one leased run                                                                                 | `agent_job`, `agent_session`                                                 |
| `agent_usage`               | agent          | token-level detail behind the `ai_*` usage events                                              | `organization`, `project`, `agent_session`, `agent_turn`                     |
| `payment_method`            | billing        | saved card metadata; never a PAN                                                               | `organization`                                                               |
| `stripe_customer`           | billing        | org ↔ Stripe customer, auto-reload config                                                      | `organization`, `payment_method`                                             |
| `credit_account`            | billing        | one per `(organization, kind)`                                                                 | `organization`                                                               |
| `credit_transaction`        | billing        | transaction header, `idempotency_key` unique                                                   | `organization`                                                               |
| `credit_ledger_entry`       | billing        | append-only signed legs; legs sum to zero                                                      | `credit_transaction`, `credit_account`                                       |
| `credit_balance_cache`      | billing        | commit-ordered checkpoint + tail sum                                                           | `credit_account`                                                             |
| `credit_hold`               | billing        | reservations so a long job cannot overdraw                                                     | `organization`, `credit_account`, `credit_transaction`                       |
| `price_book`                | billing        | versioned, carries `overhead_bps` (launch 1200)                                                | —                                                                            |
| `price_book_item`           | billing        | unit price per dimension                                                                       | `price_book`                                                                 |
| `usage_rollup`              | billing        | minute → hour → day cascade                                                                    | `organization`, `project`, `credit_transaction`                              |
| `metering_outbox`           | billing        | transactional control-plane usage awaiting Kafka publication                                   | —                                                                            |
| `metering_import_state`     | billing        | ClickHouse import cursor per consumer                                                          | —                                                                            |
| `neon_metering_state`       | billing        | last closed Neon consumption window committed per Postgres service                             | `backend_service`                                                            |
| `valkey_metering_state`     | billing        | last successful per-service queue-memory observation                                           | `backend_service`                                                            |
| `statement`                 | billing        | the monthly explicable bill                                                                    | `organization`                                                               |
| `statement_line_item`       | billing        | per-dimension legs plus the visible overhead row                                               | `statement`, `project`                                                       |
| `topup`                     | billing        | one Stripe purchase                                                                            | `organization`, `credit_transaction`                                         |
| `stripe_webhook_event`      | billing        | the dedupe table; Stripe guarantees neither order nor once-only                                | —                                                                            |
| `refund`                    | billing        | refund and its ledger clawback                                                                 | `topup`, `credit_transaction`                                                |
| `backend_service`           | data plane     | standalone or project-bound service (TASK 37)                                                  | `organization`, `project`, `region`                                          |
| `database_instance`         | data plane     | Postgres detail for a `backend_service`                                                        | `backend_service`, `project`                                                 |
| `database_branch`           | data plane     | copy-on-write branch with a TTL                                                                | `database_instance`, `database_branch` (parent)                              |
| `database_role`             | data plane     | role + envelope-encrypted password                                                             | `database_branch`                                                            |
| `search_cluster`            | data plane     | OpenSearch cluster inventory and shard budget                                                  | —                                                                            |
| `search_tenant`             | data plane     | shared-index or dedicated tenancy, quotas                                                      | `backend_service`, `project`, `search_cluster`                               |
| `cache_namespace`           | data plane     | Valkey ACL user + hash-tagged key prefix                                                       | `backend_service`, `project`                                                 |
| `observability_stream`      | observability  | per-project OTLP ingest key and retention tier                                                 | `project`                                                                    |
| `deployment`                | compute        | one build + Knative revision                                                                   | `project` (RESTRICT)                                                         |
| `deployment_build`          | compute        | one BuildKit run and its log object                                                            | `deployment`                                                                 |
| `compute_instance`          | compute        | live Fluid instance; the `pod_uid` → deployment map                                            | `deployment`                                                                 |
| `sandbox`                   | compute        | dev sandbox pod + PVC, idle reaper state                                                       | `project`, `user`                                                            |
| `workflow`                  | workflows      | graph identity; `current_version_id` **nullable** (see below)                                  | `project`, `workflow_version` (back-patched)                                 |
| `workflow_version`          | workflows      | immutable graph doc + compiled commit sha                                                      | `workflow`, `user`                                                           |
| `workflow_schedule`         | workflows      | cron, owned by the control plane not BullMQ                                                    | `workflow`                                                                   |
| `workflow_run`              | workflows      | one execution                                                                                  | `workflow`, `workflow_version`                                               |
| `workflow_run_step`         | workflows      | one node execution                                                                             | `workflow_run`                                                               |
| `workflow_job_edit_audit`   | workflows      | TASK 35 job-data edits, append-only                                                            | `workflow_run`, `organization`, `user`                                       |
| `tenant_queue`              | workflows      | queue driver, byte and concurrency quotas                                                      | `project`                                                                    |
| `oauth_client`              | oauth-provider | third-party client; the row id **is** the `client_id`                                          | `user`, `organization`                                                       |
| `oauth_client_redirect_uri` | oauth-provider | separate table so exact matching is indexed equality                                           | `oauth_client`                                                               |
| `oauth_client_secret`       | oauth-provider | argon2id hash; up to two live for rotation                                                     | `oauth_client`                                                               |
| `oauth_grant`               | oauth-provider | the durable consent record, bound to one org                                                   | `oauth_client`, `user`, `organization`                                       |
| `oauth_authorization_code`  | oauth-provider | 60s TTL, single use, S256 challenge                                                            | `oauth_client`, `user`, `organization`, `oauth_grant`                        |
| `oauth_access_token`        | oauth-provider | opaque token, stored as sha256 hex                                                             | `oauth_grant`, `oauth_client`, `user`                                        |
| `oauth_refresh_token`       | oauth-provider | rotating family with reuse detection                                                           | `oauth_grant`                                                                |
| `oauth_signing_key`         | oauth-provider | ES256 JWKS; private key KMS-wrapped                                                            | —                                                                            |
| `region`                    | platform       | a region a user may deploy into                                                                | —                                                                            |
| `cluster`                   | platform       | EKS cluster inventory                                                                          | `region`                                                                     |
| `node`                      | platform       | node inventory, metal flagged                                                                  | `cluster`                                                                    |
| `infra_deployment`          | platform       | one row per `tofu apply`, plus drift                                                           | —                                                                            |
| `background_job`            | platform       | the one job runner: `FOR UPDATE SKIP LOCKED`                                                   | `organization` (nullable)                                                    |

---

## By area

### Identity — 4 tables

`user`, `account`, `session`, `github_installation`.

The scaffold's `2024_09_20_21_14_25_init.ts` already ships `user`, `account`, `session`; the init
migration supersedes it. `account` replaces the upstream plaintext-token shape with envelope columns.
`session` gains `reauthenticated_at` for TASK 9 step-up, plus `user_agent` / `ip` for a
"sign out other sessions" screen. `github_installation` is org-scoped and singular
([0007](../adr/0007-github-installation-is-org-scoped.md)); the OAuth App has no installation concept
and no webhook ([0005](../adr/0005-both-oauth-app-and-github-app.md),
[0006](../adr/0006-single-github-webhook-receiver.md)).

### Tenancy and RBAC — 9 tables

`organization`, `organization_member`, `role`, `role_statement`, `member_role`, `member_permission`,
`organization_invite`, `user_preference`, `audit_log`.

`member_permission` is a denormalization of `role_statement` × `member_role`, rebuilt inside the same
transaction as any role, statement, or assignment change — `member_role_id ON DELETE CASCADE` handles
deletions but _not_ statement edits. Indexes: btree `(user_id, organization_id)` and GIN
`(actions array_ops, resources array_ops)`.

`audit_log` did not exist in any research area; the critique found that exactly one table audits
anything (`workflow_job_edit_audit`) while role edits, ownership transfer, credential reveals,
connection-string reveals, refunds, and impersonation audit nothing. It is
`(organization_id, actor_user_id, action, resource_srn, before, after, ip, created_at)`, append-only,
written in the mutation's transaction.

### Store — 5 tables

`store_category`, `store_listing`, `store_listing_tag`, `store_listing_screenshot`,
`store_listing_event`.

`store_listing.platform` is a Postgres enum populated only with `'web'` at v1, and
`search_vector` is a generated `tsvector` with a GIN index. Community submissions are untrusted
content: sanitize markdown, re-host screenshots on our own CDN, never render unpublished bodies.

### Projects — 6 tables

`repository`, `project`, `project_env_var`, `project_job`, `upstream_sync_run`,
`project_update_suggestion`.

`repository` and `project` are separate entities with a many-to-one link, which is what TASK 21
requires: two projects may be two directories or two branches of one repository. Upkeep therefore
runs per _repository_ and deploys run per _project_, and `upstream_sync_run` fans out into one
`project_update_suggestion` per project on that repo and branch.

`project_env_var` appears in no research area at all. A PaaS cannot ship without it; values are
envelope-encrypted under the standard column convention.

### Agent — 9 tables

`agent_credential`, `agent_config`, `agent_session`, `agent_turn`, `agent_event`,
`agent_session_entry`, `agent_job`, `agent_job_run`, `agent_usage`.

`agent_credential.kind` ∈ `claude_subscription | anthropic_api_key | openai_api_key |
openrouter_api_key`. Auto-update defaults ON only for `claude_subscription`
(see [Conflicts resolved](#conflicts-resolved)). `agent_event` holds customer source code and
possibly secrets the agent read — a 30-day default TTL is set **before** the first run, not after.

### Billing — 19 tables

`payment_method`, `stripe_customer`, `credit_account`, `credit_transaction`, `credit_ledger_entry`,
`credit_balance_cache`, `credit_hold`, `price_book`, `price_book_item`, `usage_rollup`,
`metering_outbox`, `metering_import_state`, `neon_metering_state`, `valkey_metering_state`, `statement`,
`statement_line_item`, `topup`,
`stripe_webhook_event`, `refund`.

Append-only double-entry: `credit_ledger_entry` carries a `BEFORE UPDATE OR DELETE` trigger raising
an exception, plus a deferred constraint trigger asserting each transaction's legs sum to zero.
There is never a mutable balance column; balance is `credit_balance_cache` plus the tail sum.

**The checkpoint is commit-ordered, not sequence-ordered.** The research proposed
`seq bigint GENERATED ALWAYS AS IDENTITY` with a read path of `cache.balance + SUM(seq > as_of_seq)`.
Identity values are allocated at INSERT, not COMMIT, so a transaction that takes seq 100 and commits
after the holder of 101 is skipped permanently once the compactor passes 101 — under-counting spend,
which loses money. Checkpoint against a `pg_current_snapshot()` horizon instead, or only behind the
oldest open transaction.

`price_book` + `price_book_item` **must be seeded**. Without them, rating silently produces
zero-cost usage — the most dangerous missing seed in the plan.

### Data plane — 7 tables

`backend_service`, `database_instance`, `database_branch`, `database_role`, `search_cluster`,
`search_tenant`, `cache_namespace`.

`backend_service` is the TASK 37 abstraction: `organization_id`, `kind` ∈
`postgres | valkey | elasticsearch`, `status`, `region_id`, and a **nullable** `project_id` so a
service may be standalone or project-bound. One `ServiceDriver` interface (`provision`,
`connectionUri`, `rotateCredentials`, `suspend`, `destroy`) per kind. `database_instance`,
`search_tenant`, and `cache_namespace` are the per-kind detail tables hanging off it, not parallel
concepts.

Branch TTLs must be reconciled with preview TTLs: a 24-hour branch reaper against a 7-day preview
deletes the preview's database on day two.

### Observability — 1 table

`observability_stream` — per-project OTLP ingest key hash, retention tier, monthly bytes. Log, trace,
and metric bodies live in ClickHouse, not Postgres. Telemetry never carries money
([0014](../adr/0014-one-metering-pipeline.md)).

### Compute — 4 tables

`deployment`, `deployment_build`, `compute_instance`, `sandbox`.

`compute_usage_sample` and Postgres `usage_event` are deleted. Kafka and ClickHouse retain raw
financial usage; the ClickHouse importer projects absolute totals into `usage_rollup`.
`compute_instance` survives as the `pod_uid` → deployment registry the metering agent resolves
against. `deployment.runtime_class` defaults to `kata-fc`; `sandbox.runtime_class` to `kata-clh`
([0012](../adr/0012-two-kata-runtime-classes.md), [0028](../adr/0028-kafka-clickhouse-metering.md)).

### Workflows — 7 tables

`workflow`, `workflow_version`, `workflow_schedule`, `workflow_run`, `workflow_run_step`,
`workflow_job_edit_audit`, `tenant_queue`.

`workflow_run.bytes_enqueued` and `valkey_dwell_ms` still have no writer. Their schema defaults are
not measurements, and a zero in either column must not be presented as observed queue residency.
The Valkey proxy can eventually measure residency, but it does not currently emit that usage.

### OAuth provider — 8 tables

`oauth_client`, `oauth_client_redirect_uri`, `oauth_client_secret`, `oauth_grant`,
`oauth_authorization_code`, `oauth_access_token`, `oauth_refresh_token`, `oauth_signing_key`.

A grant is bound to exactly one organization. Effective permission is the **intersection** of the
user's current RBAC set and the granted scopes, computed per request and never baked into the token,
so a demotion immediately shrinks every token already issued. Scopes reuse the
[0016](../adr/0016-one-rbac-action-catalogue.md) catalogue rather than a second vocabulary.

### Platform and infrastructure — 5 tables

`region`, `cluster`, `node`, `infra_deployment`, `background_job`.

`background_job` is the single control-plane job substrate. Nine independent schedulers were proposed
across the research — `project_job`, `agent_job`, a `croner` cron, a branch reaper, an idle reaper, a
preview sweeper, a rating job, a hold sweeper, a balance compactor, a store metadata sync, a
refresh-expiry flagger. All become job _types_ on one Postgres `FOR UPDATE SKIP LOCKED` runner with
dead-letter handling and a `run-now` HTTP trigger for local dev. `project_job` and `agent_job` stay as
domain-visible rows (they are surfaced in the UI), but they are dispatched by the one runner.

---

## Migration ordering

One init migration, in this order. Steps that are not `CREATE TABLE` are marked. This ordering is
verified against the FK edges in the summary table above; it corrects the critique's draft in six
places, noted inline.

1. **Extensions** — `citext` (invite emails), `pgcrypto`.
2. **Enum types** — `store_platform`, `store_listing_status`, `store_listing_event_kind`,
   `usage_dimension`, `credit_account_kind`, `credit_transaction_kind`.
3. `user`
4. `account`
5. `session`
6. `organization`
7. `organization_member`
8. `role`
9. `role_statement`
10. `member_role`
11. `member_permission`
12. `organization_invite`
13. `user_preference`
14. `audit_log`
15. `region` — _moved earlier than the critique's ordering, which put it near the end;
    `backend_service.region_id` references it._
16. `cluster`
17. `node`
18. `infra_deployment`
19. `background_job`
20. `github_installation`
21. `store_category`
22. `store_listing`
23. `store_listing_tag`
24. `store_listing_screenshot`
25. `store_listing_event`
26. `agent_credential` — _moved before `project`; the critique placed it after, but
    `project.agent_credential_id` references it._
27. `repository`
28. `project`
29. `project_env_var` — _absent from the critique's ordering._
30. `project_job`
31. `agent_config`
32. `backend_service` — _absent from the critique's ordering; it is the parent of the three
    service-kind detail tables._
33. `database_instance`
34. `database_branch` (self-FK `parent_branch_id`, nullable)
35. `database_role`
36. `search_cluster`
37. `search_tenant`
38. `cache_namespace`
39. `observability_stream`
40. `agent_session` — must follow `database_branch` (`db_branch_id`).
41. `agent_turn`
42. `agent_event`
43. `agent_session_entry`
44. `agent_job`
45. `agent_job_run`
46. `agent_usage`
47. `upstream_sync_run` — _moved after `agent_job_run`; the critique placed it immediately after
    `project_job`, but `upstream_sync_run.agent_run_id` references `agent_job_run`._
48. `project_update_suggestion`
49. `deployment`
50. `deployment_build`
51. `compute_instance`
52. `sandbox`
53. `workflow` — `current_version_id uuid NULL`, **no FK yet**.
54. `workflow_version`
55. **`ALTER TABLE workflow ADD CONSTRAINT workflow_current_version_id_fkey`** → `workflow_version(id)`.
56. `workflow_schedule`
57. `workflow_run`
58. `workflow_run_step`
59. `workflow_job_edit_audit`
60. `tenant_queue`
61. `price_book`
62. `price_book_item`
63. `payment_method` — _the critique called for a back-patched
    `stripe_customer.default_payment_method_id`. Verified unnecessary: `payment_method` references
    only `organization`, so creating it first removes the cycle entirely._
64. `stripe_customer` (FK to `payment_method` declared inline)
65. `credit_account`
66. `credit_transaction`
67. `credit_ledger_entry`
68. `credit_balance_cache`
69. `credit_hold`
70. `usage_event` — historical init table; removed by the ClickHouse cutover migration.
71. `usage_rollup`
72. `statement` — _absent from the critique's ordering._
73. `statement_line_item` — _absent from the critique's ordering._
74. `topup`
75. `stripe_webhook_event`
76. `refund`
77. `oauth_client`
78. `oauth_client_redirect_uri`
79. `oauth_client_secret`
80. `oauth_grant`
81. `oauth_authorization_code`
82. `oauth_access_token`
83. `oauth_refresh_token`
84. `oauth_signing_key`
85. **Triggers and deferred constraints** — append-only guards on `credit_ledger_entry`, `audit_log`,
    and `workflow_job_edit_audit`; the deferred zero-sum constraint trigger on each
    `credit_transaction`'s legs.
86. **Indexes not declared inline** — GIN `array_ops` on `member_permission(actions, resources)`, GIN
    on `store_listing.search_vector`, BRIN on `usage_event(occurred_at)`, the partial uniques listed
    under [Soft delete](#soft-delete).

`down()` reverses this list exactly, dropping the `workflow` FK constraint (step 55) before
`workflow_version`. The migration graph applying **and reversing** cleanly is the main structural
check on the whole schema, and is what catches the circular FK and any remaining dangling reference.

---

## Conflicts resolved

Every naming collision and dangling FK found while consolidating, and the name settled on.

| #   | Conflict                                                                       | Where it came from                                                                                                                                    | Resolution                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `project.store_app_id` → `store_app`                                           | projects area; `store_app` exists nowhere                                                                                                             | **`project.store_listing_id` → `store_listing`**, `ON DELETE SET NULL` ([0015](../adr/0015-store-table-is-store-listing.md))                                                             |
| 2   | `agent_credential.team_id` → `team`                                            | agent area; no `team` table is created by anyone                                                                                                      | **`agent_credential.organization_id` → `organization`**; every `team_*` action and `/teams/{teamId}` path is rewritten ([0002](../adr/0002-tenancy-noun-is-organization.md))             |
| 3   | `github_installation` defined twice                                            | auth (user-scoped, `target_user_id`) vs projects (org-scoped)                                                                                         | **One org-scoped table**; `installed_by_user_id` kept as provenance only ([0007](../adr/0007-github-installation-is-org-scoped.md))                                                      |
| 4   | `repository.installation_id bigint` FK'd to `github_installation`              | projects area; the target's PK is a uuid and `installation_id` is a bigint natural key                                                                | **`repository.github_installation_id uuid`** → `github_installation(id)`                                                                                                                 |
| 5   | `user.last_org_id` vs `user_preference.last_org_id`                            | rbac vs dashboard                                                                                                                                     | **`user_preference.last_org_id`**, one writer ([0004](../adr/0004-last-org-in-user-preference.md))                                                                                       |
| 6   | `compute_usage_sample` vs `usage_event`                                        | two complete metering pipelines                                                                                                                       | **`usage_event` only**; `compute_usage_sample` deleted ([0014](../adr/0014-one-metering-pipeline.md))                                                                                    |
| 7   | `agent_usage` as a second AI-spend ledger                                      | agent vs billing `ai_*` dimensions                                                                                                                    | `agent_usage` is a **detail table**, never billed directly; it must produce `ai_*` `usage_event` rows so the 12% overhead applies once                                                   |
| 8   | Billing dimensions missing what compute emits                                  | billing enum had no active-CPU / provisioned-memory / websocket dimensions                                                                            | `usage_dimension` gains `site_active_cpu_second`, `site_provisioned_gib_second`, `site_ws_connection_second`                                                                             |
| 9   | `project.auto_update_enabled` keys on `claude_code_oauth`                      | projects Decision 8 vs the agent credential enum, which has no such value                                                                             | Enum value is **`claude_subscription`**; auto-update defaults ON only for it                                                                                                             |
| 10  | `agent_session_entry.project_key text`                                         | agent area; a text key into nothing                                                                                                                   | **`agent_session_id uuid`** → `agent_session(id)`                                                                                                                                        |
| 11  | `database_instance` as a standalone concept                                    | data plane vs TASK 37's standalone services                                                                                                           | `database_instance` becomes the **Postgres detail table** under `backend_service`; `search_tenant` and `cache_namespace` re-parented the same way                                        |
| 12  | `cache_namespace.db_index` (numbered Valkey DBs)                               | data plane vs workflows' hash-tagged prefixes                                                                                                         | **Hash-tagged key prefix + ACL scoping**; numbered databases are forbidden under Valkey Cluster, which the queue design prepares for. `db_index` dropped                                 |
| 13  | `deployment.project_id ON DELETE CASCADE`                                      | compute area                                                                                                                                          | **`RESTRICT`** + `deleted_at` ([0017](../adr/0017-soft-delete-on-billing-referenced-tables.md))                                                                                          |
| 14  | `database_instance.project_id ON DELETE CASCADE`                               | data plane area                                                                                                                                       | **`RESTRICT`** + `deleted_at`, same reason                                                                                                                                               |
| 15  | `organization.owner_user_id RESTRICT` vs `organization_member.user_id CASCADE` | rbac area                                                                                                                                             | User deletion is structurally impossible as written. Resolved in the init migration: `user` is soft-deletable, and deletion is a phase-18 workflow (reassign owned orgs, then anonymize) |
| 16  | `payment_method.exp_bear`                                                      | billing area                                                                                                                                          | Typo. **`exp_year`** — it would otherwise be baked into generated Kysely types and every serializer                                                                                      |
| 17  | `app_user_database.database_id`                                                | oauth-provider references a data-plane table at the opposite end of the build order                                                                   | Table **deferred** with the per-user-DB feature                                                                                                                                          |
| 18  | Resource strings that are not SRNs                                             | data plane wrote `["project:<id>"]`                                                                                                                   | All resources are SRNs, `srn:sproutos:<service>:<org_id>:<type>/<id>` ([0016](../adr/0016-one-rbac-action-catalogue.md))                                                                 |
| 19  | Mixed `.` and `:` separators in actions                                        | rbac's `workflow:job.peek` vs workflows' `workflow:job:read`                                                                                          | **`:` only**, everywhere; wildcards expand on `:` boundaries ([0016](../adr/0016-one-rbac-action-catalogue.md))                                                                          |
| 20  | Four envelope-encryption column conventions                                    | auth `access_token_ct`/`data_key_ct`, agent `ciphertext`/`wrapped_dek`, data plane `password_ciphertext`/`kms_key_id`, oauth `private_key_ciphertext` | **One convention**: `{field}_ciphertext`, `{field}_wrapped_dek`, `kms_key_id`, via `@lib/envelope`                                                                                       |
| 21  | Nine independent job schedulers                                                | every area                                                                                                                                            | One `background_job` runner; everything else is a job type                                                                                                                               |

---

## Deferred

Tables the plan explicitly descopes. They are named here so nobody re-derives them mid-build.

| table                                                       | why deferred                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app_user_database`                                         | Per-user databases are descoped from OAuth v1. At 100k+ databases the feature needs control-plane capabilities that do not exist until the phase-8 Postgres plane matures — the data-plane notes name that exact workload as a self-hosting crossover trigger. Phase 17 issues a scoped token against the `backend_service` API instead                                                                            |
| `store_listing_platform`                                    | Non-web platforms (TASK 18). The `platform` enum carries the values from day one so filters keep working, but build, signing, and distribution for Android/iOS/Windows/macOS/Linux are not designed. `ALTER TYPE … ADD VALUE` plus this table when they are                                                                                                                                                        |
| `notification`, `notification_preference`, `email_delivery` | No area designed a template system, bounce/complaint handling, or unsubscribe. Nine notification triggers exist across the areas (low balance, auto-reload failure, SCA fallback, dispute, refresh-token expiry, setup-token expiry, upkeep failure, build failure, branch-quota exhaustion, moderation decisions). SES will suspend an account that ignores bounces, so this is a real phase-18 gap, not a nicety |
| `custom_domain`                                             | Custom tenant domains are a PaaS table-stake that nobody designed. Blocked on the ALB's 25-certificates-per-listener soft limit, so it needs an SNI-via-CloudFront design first                                                                                                                                                                                                                                    |
| `compute_usage_sample`                                      | Superseded by `usage_event` ([0014](../adr/0014-one-metering-pipeline.md))                                                                                                                                                                                                                                                                                                                                         |
| `oauth_device_code`                                         | No device grant in v1; add RFC 8628 when we ship a CLI                                                                                                                                                                                                                                                                                                                                                             |
| `team`                                                      | Never existed ([0002](../adr/0002-tenancy-noun-is-organization.md))                                                                                                                                                                                                                                                                                                                                                |
| `store_app`                                                 | Never existed ([0015](../adr/0015-store-table-is-store-listing.md))                                                                                                                                                                                                                                                                                                                                                |
| _platform-admin table_                                      | Platform admin stays the scaffold's `user.is_admin` boolean for v1. Impersonation and its audit trail are phase 18, and land in `audit_log`                                                                                                                                                                                                                                                                        |
| _listing ratings / reviews_                                 | Google's `SoftwareApplication` rich result wants `aggregateRating`, and we must not synthesize one from GitHub stars                                                                                                                                                                                                                                                                                               |

---

## Special cases

### The circular FK

`workflow.current_version_id → workflow_version.id` and `workflow_version.workflow_id → workflow.id`
is a genuine cycle — the only one in the schema.

It is broken by creating `workflow.current_version_id` as a **nullable column with no constraint**
(step 53), creating `workflow_version` (step 54), then adding the constraint by
`ALTER TABLE` (step 55). `down()` drops the constraint before dropping `workflow_version`.

`DEFERRABLE INITIALLY DEFERRED` would also work and was considered. The `ALTER TABLE` form is
preferred because it keeps normal-path inserts on immediate constraint checking, and because a
deferred constraint that fails does so at COMMIT, where the error is much harder to attribute.

### Soft delete

Anything durable billing history references is soft-deleted; a hard delete destroys that history
([0017](../adr/0017-soft-delete-on-billing-referenced-tables.md)).

`deleted_at timestamptz NULL` on: `organization`, `project`, `user`, `repository`,
`github_installation`, `store_listing`, `backend_service`, `database_instance`, `deployment`,
`agent_credential`, `workflow`.

`usage_rollup.organization_id`, `usage_rollup.project_id`, `statement_line_item.project_id`,
`deployment.project_id`, and `database_instance.project_id` are `ON DELETE RESTRICT`.

Every DAO `fetch*` filters `deleted_at IS NULL` by default. Uniqueness that must be reusable after
deletion becomes a partial unique index `WHERE deleted_at IS NULL` — specifically
`project(organization_id, slug)`, `organization(slug)`, `workflow(project_id, slug)`, and
`repository(organization_id, github_repo_id)`.

Deletion is a state change plus a teardown job on the `background_job` runner, which tears down
Knative services, database branches, ECR images, and search indexes before marking child rows
deleted. A retention job hard-deletes soft-deleted rows only after retained billing and audit rows
no longer require them.

### Partitioning

No current Postgres table is partitioned. Raw usage formerly lived in daily `usage_event`
partitions, but the fixed partition window was the failure that forced ADR 0028. Raw retention is
now ClickHouse TTL; Postgres retains financial rollups and ledger state.

`agent_event` and `audit_log` are partitioning candidates once volume justifies it. Neither is
partitioned at init; both are append-only and time-ordered, so converting later is mechanical.

### Envelope encryption

One package, `@lib/envelope`, one column convention: `{field}_ciphertext bytea`,
`{field}_wrapped_dek bytea`, `kms_key_id text`. It runs against the real `@aws-sdk/client-kms`
locally through LocalStack, so dev and prod share a code path.

Columns using it: `account.access_token_*` / `account.refresh_token_*`, `agent_credential.secret_*`,
`project_env_var.value_*`, `database_role.password_*`, `cache_namespace.acl_password_*`,
`oauth_signing_key.private_key_*`.

Not envelope-encrypted, deliberately: `session.session_key`, `organization_invite.token_hash`,
`oauth_access_token.token_hash`, `oauth_refresh_token.token_hash`,
`oauth_authorization_code.code_hash`, and `observability_stream.otlp_ingest_key_hash` are **hashes**
(sha256 hex), and `oauth_client_secret.secret_hash` is argon2id. Hashes are never decrypted, so they
never need a DEK.

### Seeds

Non-negotiable, in this order: `price_book` + `price_book_item` (**without these, rating silently
produces zero-cost usage**), the three system roles per organization, `region`, `store_category`, the
store listing catalogue, and a dev user + organization + project so `pnpm dev` shows a populated
dashboard rather than an empty state.
