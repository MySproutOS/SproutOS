// DDL is ordered by the foreign-key graph, so every statement must await the one before it.
/* oxlint-disable no-await-in-loop */
import { type Kysely, sql } from "kysely"

const DIMENSIONS =
  "'site_vcpu_second', 'site_gib_second', 'site_request', 'site_egress_byte', " +
  "'site_active_cpu_second', 'site_provisioned_gib_second', 'site_ws_connection_second', " +
  "'db_storage_gib_hour', 'db_compute_cu_second', 'es_storage_gib_hour', 'es_search_unit', " +
  "'valkey_queue_byte_second', 'workflow_job_enqueued', 'workflow_exec_vcpu_second', " +
  "'workflow_exec_gib_second', 'ai_input_token', 'ai_output_token', 'ai_cache_read_token', " +
  "'agent_run_second'"

const TABLE_ORDER = [
  "user",
  "account",
  "session",
  "organization",
  "organization_member",
  "role",
  "role_statement",
  "member_role",
  "member_permission",
  "organization_invite",
  "user_preference",
  "audit_log",
  "region",
  "cluster",
  "node",
  "infra_deployment",
  "background_job",
  "github_installation",
  "store_category",
  "store_listing",
  "store_listing_tag",
  "store_listing_screenshot",
  "store_listing_event",
  "agent_credential",
  "repository",
  "project",
  "project_env_var",
  "project_job",
  "agent_config",
  "backend_service",
  "database_instance",
  "database_branch",
  "database_role",
  "search_cluster",
  "search_tenant",
  "cache_namespace",
  "observability_stream",
  "agent_session",
  "agent_turn",
  "agent_event",
  "agent_session_entry",
  "agent_job",
  "agent_job_run",
  "agent_usage",
  "upstream_sync_run",
  "project_update_suggestion",
  "deployment",
  "deployment_build",
  "compute_instance",
  "sandbox",
  "workflow",
  "workflow_version",
  "workflow_schedule",
  "workflow_run",
  "workflow_run_step",
  "workflow_job_edit_audit",
  "tenant_queue",
  "price_book",
  "price_book_item",
  "payment_method",
  "stripe_customer",
  "credit_account",
  "credit_transaction",
  "credit_ledger_entry",
  "credit_balance_cache",
  "credit_hold",
  "usage_event",
  "usage_rollup",
  "statement",
  "statement_line_item",
  "topup",
  "stripe_webhook_event",
  "refund",
  "oauth_client",
  "oauth_client_redirect_uri",
  "oauth_client_secret",
  "oauth_grant",
  "oauth_authorization_code",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_signing_key",
] as const

const fkIndexes = async (
  db: Kysely<any>,
  table: string,
  columns: readonly string[],
): Promise<void> => {
  for (const column of columns) {
    await db.schema.createIndex(`${table}_${column}_idx`).on(table).column(column).execute()
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create extension if not exists citext`.execute(db)
  await sql`create extension if not exists pgcrypto`.execute(db)

  await db.schema
    .createTable("user")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("name", "text")
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("image", "text")
    .addColumn("github_login", "text")
    .addColumn("github_user_id", "bigint")
    .addColumn("is_admin", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addUniqueConstraint("user_email_key", ["email"])
    .addUniqueConstraint("user_github_login_key", ["github_login"])
    .addUniqueConstraint("user_github_user_id_key", ["github_user_id"])
    .execute()

  await db.schema.createIndex("user_email_idx").on("user").column("email").execute()

  await db.schema
    .createTable("account")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("provider_account_id", "text", (col) => col.notNull())
    .addColumn("access_token_ciphertext", "text")
    .addColumn("access_token_wrapped_dek", "text")
    .addColumn("access_token_kms_key_id", "text")
    .addColumn("refresh_token_ciphertext", "text")
    .addColumn("refresh_token_wrapped_dek", "text")
    .addColumn("refresh_token_kms_key_id", "text")
    .addColumn("access_token_expires_at", "timestamptz")
    .addColumn("refresh_token_expires_at", "timestamptz")
    .addColumn("scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("token_type", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("account_provider_provider_account_id_key", [
      "provider",
      "provider_account_id",
    ])
    .addCheckConstraint("account_type_check", sql`type in ('oauth', 'oidc', 'email')`)
    .execute()

  await fkIndexes(db, "account", ["user_id"])

  await db.schema
    .createTable("session")
    .addColumn("session_key", "text", (col) => col.primaryKey())
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("expires", "timestamptz", (col) => col.notNull())
    .addColumn("reauthenticated_at", "timestamptz")
    .addColumn("user_agent", "text")
    .addColumn("ip", sql`inet`)
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "session", ["user_id", "expires"])

  await db.schema
    .createTable("organization")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("owner_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict").notNull(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("organization_kind_check", sql`kind in ('personal', 'team')`)
    .execute()

  await sql`
    create unique index organization_slug_live_key on organization (slug) where deleted_at is null
  `.execute(db)
  await fkIndexes(db, "organization", ["owner_user_id"])

  await db.schema
    .createTable("organization_member")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("organization_member_org_user_key", ["organization_id", "user_id"])
    .addCheckConstraint("organization_member_status_check", sql`status in ('active', 'suspended')`)
    .execute()

  await fkIndexes(db, "organization_member", ["organization_id", "user_id"])

  await db.schema
    .createTable("role")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("is_system", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("role_organization_id_name_key", ["organization_id", "name"])
    .execute()

  await fkIndexes(db, "role", ["organization_id"])

  await db.schema
    .createTable("role_statement")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("role_id", "uuid", (col) => col.references("role.id").onDelete("cascade").notNull())
    .addColumn("effect", "text", (col) => col.notNull())
    .addColumn("actions", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("resources", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("role_statement_effect_check", sql`effect in ('allow', 'deny')`)
    .execute()

  await fkIndexes(db, "role_statement", ["role_id"])

  await db.schema
    .createTable("member_role")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_member_id", "uuid", (col) =>
      col.references("organization_member.id").onDelete("cascade").notNull(),
    )
    .addColumn("role_id", "uuid", (col) => col.references("role.id").onDelete("cascade").notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("member_role_member_role_key", ["organization_member_id", "role_id"])
    .execute()

  await fkIndexes(db, "member_role", ["organization_member_id", "role_id"])

  await db.schema
    .createTable("member_permission")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("member_role_id", "uuid", (col) =>
      col.references("member_role.id").onDelete("cascade").notNull(),
    )
    .addColumn("effect", "text", (col) => col.notNull())
    .addColumn("actions", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("resources", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("member_permission_effect_check", sql`effect in ('allow', 'deny')`)
    .execute()

  await fkIndexes(db, "member_permission", ["organization_id", "member_role_id"])
  await sql`
    create index member_permission_user_organization_idx
      on member_permission (user_id, organization_id)
  `.execute(db)
  await sql`
    create index member_permission_actions_resources_gin_idx
      on member_permission using gin (actions array_ops, resources array_ops)
  `.execute(db)

  await db.schema
    .createTable("organization_invite")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("email", sql`citext`, (col) => col.notNull())
    .addColumn("role_id", "uuid", (col) => col.references("role.id").onDelete("restrict").notNull())
    .addColumn("invited_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("accepted_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("organization_invite_token_hash_key", ["token_hash"])
    .execute()

  await fkIndexes(db, "organization_invite", ["organization_id", "role_id", "invited_by_user_id"])
  await sql`
    create unique index organization_invite_pending_key on organization_invite
      (organization_id, email) where accepted_at is null and revoked_at is null
  `.execute(db)

  await db.schema
    .createTable("user_preference")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("last_org_id", "uuid", (col) =>
      col.references("organization.id").onDelete("set null"),
    )
    .addColumn("sidebar_collapsed", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("nav_pinned_project_ids", sql`uuid[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("user_preference_user_id_key", ["user_id"])
    .execute()

  await fkIndexes(db, "user_preference", ["last_org_id"])

  await db.schema
    .createTable("audit_log")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict"),
    )
    .addColumn("actor_user_id", "uuid", (col) => col.references("user.id").onDelete("restrict"))
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("resource_srn", "text")
    .addColumn("before", "jsonb")
    .addColumn("after", "jsonb")
    .addColumn("ip", sql`inet`)
    .addColumn("user_agent", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "audit_log", ["actor_user_id", "action"])
  await sql`
    create index audit_log_organization_created_idx on audit_log (organization_id, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("region")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("code", "text", (col) => col.notNull())
    .addColumn("display_name", "text", (col) => col.notNull())
    .addColumn("is_active", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("region_code_key", ["code"])
    .execute()

  await db.schema
    .createTable("cluster")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("region_id", "uuid", (col) =>
      col.references("region.id").onDelete("restrict").notNull(),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("environment", "text", (col) => col.notNull())
    .addColumn("kubernetes_version", "text", (col) => col.notNull())
    .addColumn("endpoint", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("provisioning"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("cluster_region_id_name_key", ["region_id", "name"])
    .addCheckConstraint("cluster_environment_check", sql`environment in ('dev', 'staging', 'prod')`)
    .addCheckConstraint(
      "cluster_status_check",
      sql`status in ('provisioning', 'active', 'draining', 'deleted')`,
    )
    .execute()

  await fkIndexes(db, "cluster", ["region_id"])

  await db.schema
    .createTable("node")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("cluster_id", "uuid", (col) =>
      col.references("cluster.id").onDelete("cascade").notNull(),
    )
    .addColumn("instance_id", "text", (col) => col.notNull())
    .addColumn("instance_type", "text", (col) => col.notNull())
    .addColumn("is_bare_metal", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("runtime_class", "text")
    .addColumn("allocatable_cpu_millis", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("allocatable_memory_bytes", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("ready"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("node_instance_id_key", ["instance_id"])
    .addCheckConstraint("node_status_check", sql`status in ('ready', 'cordoned', 'terminating')`)
    .execute()

  await fkIndexes(db, "node", ["cluster_id"])

  await db.schema
    .createTable("infra_deployment")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("stack", "text", (col) => col.notNull())
    .addColumn("environment", "text", (col) => col.notNull())
    .addColumn("git_sha", "text", (col) => col.notNull())
    .addColumn("plan_summary", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("drift_detected_at", "timestamptz")
    .addColumn("applied_at", "timestamptz")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("planned"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "infra_deployment_stack_check",
      sql`stack in ('bootstrap', 'network', 'cluster', 'data', 'platform', 'delivery')`,
    )
    .addCheckConstraint(
      "infra_deployment_environment_check",
      sql`environment in ('dev', 'staging', 'prod')`,
    )
    .addCheckConstraint(
      "infra_deployment_status_check",
      sql`status in ('planned', 'applied', 'failed', 'drifted')`,
    )
    .execute()

  await sql`
    create index infra_deployment_stack_env_created_idx
      on infra_deployment (stack, environment, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("background_job")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("payload", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("state", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("priority", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("run_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("lease_expires_at", "timestamptz")
    .addColumn("locked_by", "text")
    .addColumn("attempt", "int2", (col) => col.notNull().defaultTo(0))
    .addColumn("max_attempts", "int2", (col) => col.notNull().defaultTo(5))
    .addColumn("idempotency_key", "text")
    .addColumn("last_error", "text")
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("background_job_idempotency_key_key", ["idempotency_key"])
    .addCheckConstraint(
      "background_job_state_check",
      sql`state in ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_lettered', 'cancelled')`,
    )
    .execute()

  await fkIndexes(db, "background_job", ["organization_id", "kind"])
  await sql`
    create index background_job_state_run_at_idx on background_job (state, run_at)
  `.execute(db)
  await sql`
    create index background_job_lease_idx on background_job (lease_expires_at)
      where lease_expires_at is not null
  `.execute(db)

  await db.schema
    .createTable("github_installation")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("installation_id", "bigint", (col) => col.notNull())
    .addColumn("account_login", "text", (col) => col.notNull())
    .addColumn("account_type", "text", (col) => col.notNull())
    .addColumn("repository_selection", "text", (col) => col.notNull().defaultTo("selected"))
    .addColumn("permissions", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("installed_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("suspended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addUniqueConstraint("github_installation_installation_id_key", ["installation_id"])
    .addCheckConstraint(
      "github_installation_account_type_check",
      sql`account_type in ('User', 'Organization')`,
    )
    .addCheckConstraint(
      "github_installation_repository_selection_check",
      sql`repository_selection in ('all', 'selected')`,
    )
    .execute()

  await fkIndexes(db, "github_installation", ["organization_id", "installed_by_user_id"])

  await db.schema
    .createTable("store_category")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("store_category_slug_key", ["slug"])
    .execute()

  await db.schema
    .createTable("store_listing")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("tagline", "text", (col) => col.notNull())
    .addColumn("description_md", "text", (col) => col.notNull())
    .addColumn("readme_md", "text")
    .addColumn("readme_etag", "text")
    .addColumn("upstream_host", "text", (col) => col.notNull().defaultTo("github.com"))
    .addColumn("upstream_owner", "text", (col) => col.notNull())
    .addColumn("upstream_repo", "text", (col) => col.notNull())
    .addColumn("upstream_repo_url", "text", (col) => col.notNull())
    .addColumn("homepage_url", "text")
    .addColumn("default_branch", "text", (col) => col.notNull().defaultTo("main"))
    .addColumn("license_spdx", "text")
    .addColumn("platform", "text", (col) => col.notNull().defaultTo("web"))
    .addColumn("category_id", "uuid", (col) =>
      col.references("store_category.id").onDelete("set null"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("draft"))
    .addColumn("submitted_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("reviewed_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("reviewed_at", "timestamptz")
    .addColumn("rejection_reason", "text")
    .addColumn("stars_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("forks_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("install_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("upstream_pushed_at", "timestamptz")
    .addColumn("last_synced_at", "timestamptz")
    .addColumn("sync_error", "text")
    .addColumn("featured_rank", "integer")
    .addColumn("search_vector", sql`tsvector`, (col) =>
      col
        .generatedAlwaysAs(
          sql`setweight(to_tsvector('english', name), 'A')
            || setweight(to_tsvector('english', tagline), 'B')
            || setweight(to_tsvector('english', coalesce(description_md, '')), 'C')`,
        )
        .stored(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("store_listing_slug_check", sql`slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'`)
    .addCheckConstraint("store_listing_tagline_check", sql`length(tagline) <= 140`)
    .addCheckConstraint(
      "store_listing_platform_check",
      sql`platform in ('web', 'android', 'ios', 'windows', 'macos', 'linux_debian')`,
    )
    .addCheckConstraint(
      "store_listing_status_check",
      sql`status in ('draft', 'pending_review', 'published', 'rejected', 'archived')`,
    )
    .execute()

  await fkIndexes(db, "store_listing", [
    "category_id",
    "submitted_by_user_id",
    "reviewed_by_user_id",
  ])
  await sql`
    create unique index store_listing_slug_live_key on store_listing (slug)
      where deleted_at is null
  `.execute(db)
  await sql`
    create unique index store_listing_upstream_live_key on store_listing
      (upstream_host, upstream_owner, upstream_repo) where deleted_at is null
  `.execute(db)
  await sql`
    create index store_listing_search_vector_gin_idx on store_listing using gin (search_vector)
  `.execute(db)
  await sql`
    create index store_listing_published_rank_idx on store_listing
      (featured_rank, stars_count desc) where status = 'published' and deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("store_listing_tag")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("store_listing_id", "uuid", (col) =>
      col.references("store_listing.id").onDelete("cascade").notNull(),
    )
    .addColumn("tag", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("store_listing_tag_listing_tag_key", ["store_listing_id", "tag"])
    .execute()

  await fkIndexes(db, "store_listing_tag", ["store_listing_id", "tag"])

  await db.schema
    .createTable("store_listing_screenshot")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("store_listing_id", "uuid", (col) =>
      col.references("store_listing.id").onDelete("cascade").notNull(),
    )
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("alt_text", "text")
    .addColumn("width", "integer")
    .addColumn("height", "integer")
    .addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "store_listing_screenshot", ["store_listing_id"])

  await db.schema
    .createTable("store_listing_event")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("store_listing_id", "uuid", (col) =>
      col.references("store_listing.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("set null"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "store_listing_event_kind_check",
      sql`kind in ('view', 'visit_upstream', 'fork_started', 'fork_completed')`,
    )
    .execute()

  await fkIndexes(db, "store_listing_event", ["user_id"])
  await sql`
    create index store_listing_event_listing_created_idx on store_listing_event
      (store_listing_id, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("agent_credential")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("label", "text", (col) => col.notNull())
    .addColumn("secret_ciphertext", "text", (col) => col.notNull())
    .addColumn("secret_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("secret_kms_key_id", "text", (col) => col.notNull())
    .addColumn("last_four", "text")
    .addColumn("base_url", "text")
    .addColumn("expires_at", "timestamptz")
    .addColumn("last_verified_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "agent_credential_kind_check",
      sql`kind in ('claude_subscription', 'anthropic_api_key', 'openai_api_key', 'openrouter_api_key')`,
    )
    .execute()

  await fkIndexes(db, "agent_credential", ["organization_id"])
  await sql`
    create unique index agent_credential_label_live_key on agent_credential
      (organization_id, label) where deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("repository")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("github_repo_id", "bigint", (col) => col.notNull())
    .addColumn("owner_login", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("default_branch", "text", (col) => col.notNull().defaultTo("main"))
    .addColumn("private", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("is_fork", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("provenance", "text", (col) => col.notNull())
    .addColumn("upstream_github_repo_id", "bigint")
    .addColumn("upstream_full_name", "text")
    .addColumn("upstream_default_branch", "text")
    .addColumn("github_installation_id", "uuid", (col) =>
      col.references("github_installation.id").onDelete("set null"),
    )
    .addColumn("last_synced_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "repository_provenance_check",
      sql`provenance in ('fork', 'template', 'new', 'imported', 'copy')`,
    )
    .execute()

  await fkIndexes(db, "repository", ["organization_id", "github_installation_id"])
  await sql`
    create unique index repository_org_github_repo_live_key on repository
      (organization_id, github_repo_id) where deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("project")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("repository_id", "uuid", (col) =>
      col.references("repository.id").onDelete("restrict").notNull(),
    )
    .addColumn("store_listing_id", "uuid", (col) =>
      col.references("store_listing.id").onDelete("set null"),
    )
    .addColumn("agent_credential_id", "uuid", (col) =>
      col.references("agent_credential.id").onDelete("set null"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("site"))
    .addColumn("root_dir", "text", (col) => col.notNull().defaultTo("."))
    .addColumn("production_branch", "text", (col) => col.notNull().defaultTo("main"))
    .addColumn("state", "text", (col) => col.notNull().defaultTo("creating"))
    .addColumn("state_reason", "text")
    .addColumn("auto_update_enabled", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("auto_update_mode", "text", (col) => col.notNull().defaultTo("suggest"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("project_kind_check", sql`kind in ('site', 'workflow')`)
    .addCheckConstraint(
      "project_state_check",
      sql`state in ('creating', 'provisioning', 'ready', 'deploying', 'failed', 'deleting', 'deleted')`,
    )
    .addCheckConstraint(
      "project_auto_update_mode_check",
      sql`auto_update_mode in ('suggest', 'auto_merge')`,
    )
    .execute()

  await fkIndexes(db, "project", [
    "organization_id",
    "repository_id",
    "store_listing_id",
    "agent_credential_id",
  ])
  await sql`
    create unique index project_org_slug_live_key on project (organization_id, slug)
      where deleted_at is null
  `.execute(db)
  await sql`
    create unique index project_repository_target_live_key on project
      (organization_id, repository_id, root_dir, production_branch) where deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("project_env_var")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("target", "text", (col) => col.notNull().defaultTo("all"))
    .addColumn("value_ciphertext", "text", (col) => col.notNull())
    .addColumn("value_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("value_kms_key_id", "text", (col) => col.notNull())
    .addColumn("is_secret", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("project_env_var_project_key_target_key", ["project_id", "key", "target"])
    .addCheckConstraint(
      "project_env_var_target_check",
      sql`target in ('production', 'preview', 'development', 'all')`,
    )
    .execute()

  await fkIndexes(db, "project_env_var", ["project_id"])

  await db.schema
    .createTable("project_job")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("cascade"))
    .addColumn("repository_id", "uuid", (col) =>
      col.references("repository.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("steps", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("progress", "int2", (col) => col.notNull().defaultTo(0))
    .addColumn("error_code", "text")
    .addColumn("error_message", "text")
    .addColumn("idempotency_key", "text")
    .addColumn("attempt", "int2", (col) => col.notNull().defaultTo(0))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("project_job_idempotency_key_key", ["idempotency_key"])
    .addCheckConstraint(
      "project_job_kind_check",
      sql`kind in ('provision', 'fork', 'sync_upstream', 'delete')`,
    )
    .addCheckConstraint(
      "project_job_state_check",
      sql`state in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    )
    .execute()

  await fkIndexes(db, "project_job", ["organization_id", "project_id", "repository_id"])
  await sql`
    create index project_job_state_created_idx on project_job (state, created_at)
  `.execute(db)

  await db.schema
    .createTable("agent_config")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade"),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("cascade"))
    .addColumn("agent_credential_id", "uuid", (col) =>
      col.references("agent_credential.id").onDelete("set null"),
    )
    .addColumn("use_sproutos_credits", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("model", "text")
    .addColumn("max_budget_micro_usd", "bigint")
    .addColumn("permission_mode", "text", (col) => col.notNull().defaultTo("default"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("agent_config_scope_check", sql`scope in ('organization', 'project')`)
    .addCheckConstraint(
      "agent_config_permission_mode_check",
      sql`permission_mode in ('default', 'plan', 'accept_edits', 'bypass_permissions')`,
    )
    .addCheckConstraint(
      "agent_config_scope_target_check",
      sql`(scope = 'organization' and organization_id is not null and project_id is null)
        or (scope = 'project' and project_id is not null and organization_id is null)`,
    )
    .execute()

  await fkIndexes(db, "agent_config", ["agent_credential_id"])
  await sql`
    create unique index agent_config_organization_key on agent_config (organization_id)
      where scope = 'organization'
  `.execute(db)
  await sql`
    create unique index agent_config_project_key on agent_config (project_id)
      where scope = 'project'
  `.execute(db)

  await db.schema
    .createTable("backend_service")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("region_id", "uuid", (col) =>
      col.references("region.id").onDelete("restrict").notNull(),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("provisioning"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "backend_service_kind_check",
      sql`kind in ('postgres', 'valkey', 'elasticsearch')`,
    )
    .addCheckConstraint(
      "backend_service_status_check",
      sql`status in ('provisioning', 'active', 'suspended', 'deleting', 'error')`,
    )
    .execute()

  await fkIndexes(db, "backend_service", ["organization_id", "project_id", "region_id"])

  await db.schema
    .createTable("database_instance")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("provider_project_id", "text")
    .addColumn("provider_org_id", "text")
    .addColumn("region", "text")
    .addColumn("pg_version", "int2")
    .addColumn("autosuspend_seconds", "integer", (col) => col.notNull().defaultTo(300))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("provisioning"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "database_instance_provider_check",
      sql`provider in ('neon', 'byo', 'sprout')`,
    )
    .addCheckConstraint(
      "database_instance_status_check",
      sql`status in ('provisioning', 'active', 'suspended', 'deleting', 'error')`,
    )
    .execute()

  await fkIndexes(db, "database_instance", ["project_id"])
  await sql`
    create unique index database_instance_backend_service_live_key on database_instance
      (backend_service_id) where deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("database_branch")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("database_instance_id", "uuid", (col) =>
      col.references("database_instance.id").onDelete("cascade").notNull(),
    )
    .addColumn("parent_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("set null"),
    )
    .addColumn("provider_branch_id", "text")
    .addColumn("provider_endpoint_id", "text")
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("primary"))
    .addColumn("host", "text")
    .addColumn("pooled_host", "text")
    .addColumn("is_protected", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("database_branch_instance_name_key", ["database_instance_id", "name"])
    .addCheckConstraint(
      "database_branch_kind_check",
      sql`kind in ('primary', 'dev', 'upkeep', 'preview')`,
    )
    .execute()

  await fkIndexes(db, "database_branch", ["database_instance_id", "parent_branch_id"])
  await sql`
    create index database_branch_reaper_idx on database_branch (expires_at)
      where expires_at is not null and is_protected = false
  `.execute(db)

  await db.schema
    .createTable("database_role")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade").notNull(),
    )
    .addColumn("role_name", "text", (col) => col.notNull())
    .addColumn("password_ciphertext", "text", (col) => col.notNull())
    .addColumn("password_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("password_kms_key_id", "text", (col) => col.notNull())
    .addColumn("revealed_at", "timestamptz")
    .addColumn("rotated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("database_role_branch_name_key", ["database_branch_id", "role_name"])
    .execute()

  await fkIndexes(db, "database_role", ["database_branch_id"])

  await db.schema
    .createTable("search_cluster")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("endpoint", "text", (col) => col.notNull())
    .addColumn("node_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("total_shards", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("max_shards", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("accepting_new_tenants", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("search_cluster_name_key", ["name"])
    .execute()

  await db.schema
    .createTable("search_tenant")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("search_cluster_id", "uuid", (col) =>
      col.references("search_cluster.id").onDelete("restrict").notNull(),
    )
    .addColumn("routing_key", "text", (col) => col.notNull())
    .addColumn("mode", "text", (col) => col.notNull().defaultTo("shared"))
    .addColumn("index_pattern", "text", (col) => col.notNull())
    .addColumn("doc_count_estimate", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("bytes_estimate", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("quota_bytes", "bigint")
    .addColumn("quota_qps", "integer")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("search_tenant_cluster_routing_key", ["search_cluster_id", "routing_key"])
    .addCheckConstraint("search_tenant_mode_check", sql`mode in ('shared', 'dedicated')`)
    .execute()

  await fkIndexes(db, "search_tenant", ["backend_service_id", "project_id", "search_cluster_id"])

  await db.schema
    .createTable("cache_namespace")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("key_prefix", "text", (col) => col.notNull())
    .addColumn("acl_username", "text", (col) => col.notNull())
    .addColumn("acl_password_ciphertext", "text", (col) => col.notNull())
    .addColumn("acl_password_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("acl_password_kms_key_id", "text", (col) => col.notNull())
    .addColumn("maxmemory_bytes", "bigint")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("cache_namespace_acl_username_key", ["acl_username"])
    .addUniqueConstraint("cache_namespace_service_prefix_key", ["backend_service_id", "key_prefix"])
    .execute()

  await fkIndexes(db, "cache_namespace", ["backend_service_id", "project_id"])

  await db.schema
    .createTable("observability_stream")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("otlp_ingest_key_hash", "text", (col) => col.notNull())
    .addColumn("retention_days", "int2", (col) => col.notNull().defaultTo(7))
    .addColumn("bytes_ingested_month", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("observability_stream_project_id_key", ["project_id"])
    .addUniqueConstraint("observability_stream_ingest_key_hash_key", ["otlp_ingest_key_hash"])
    .addCheckConstraint(
      "observability_stream_retention_days_check",
      sql`retention_days in (7, 30, 90)`,
    )
    .execute()

  await db.schema
    .createTable("agent_session")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("created_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("db_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("set null"),
    )
    .addColumn("sdk_session_id", "text")
    .addColumn("title", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("runner_pod", "text")
    .addColumn("branch_name", "text")
    .addColumn("archived_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "agent_session_status_check",
      sql`status in ('active', 'idle', 'completed', 'failed', 'archived')`,
    )
    .execute()

  await fkIndexes(db, "agent_session", ["project_id", "created_by_user_id", "db_branch_id"])

  await db.schema
    .createTable("agent_turn")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("cascade").notNull(),
    )
    .addColumn("seq", "integer", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("input_text", "text")
    .addColumn("result_subtype", "text")
    .addColumn("estimated_cost_micro_usd", "bigint")
    .addColumn("num_turns", "integer")
    .addColumn("duration_ms", "integer")
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("agent_turn_session_seq_key", ["agent_session_id", "seq"])
    .addCheckConstraint("agent_turn_role_check", sql`role in ('user', 'assistant', 'system')`)
    .execute()

  await fkIndexes(db, "agent_turn", ["agent_session_id"])

  await db.schema
    .createTable("agent_event")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("cascade").notNull(),
    )
    .addColumn("agent_turn_id", "uuid", (col) =>
      col.references("agent_turn.id").onDelete("cascade"),
    )
    .addColumn("seq", "bigint", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("payload", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now() + interval '30 days'`),
    )
    .addUniqueConstraint("agent_event_session_seq_key", ["agent_session_id", "seq"])
    .execute()

  await fkIndexes(db, "agent_event", ["agent_session_id", "agent_turn_id", "expires_at"])

  await db.schema
    .createTable("agent_session_entry")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("cascade").notNull(),
    )
    .addColumn("sdk_session_id", "text")
    .addColumn("subpath", "text")
    .addColumn("ord", "bigint", (col) => col.notNull().generatedAlwaysAsIdentity())
    .addColumn("entry", "jsonb", (col) => col.notNull())
    .addColumn("entry_uuid", "uuid", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("agent_session_entry_entry_uuid_key", ["entry_uuid"])
    .execute()

  await sql`
    create index agent_session_entry_session_ord_idx on agent_session_entry
      (agent_session_id, ord)
  `.execute(db)

  await db.schema
    .createTable("agent_job")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("cron_expression", "text")
    .addColumn("timezone", "text", (col) => col.notNull().defaultTo("UTC"))
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("next_run_at", "timestamptz")
    .addColumn("last_run_at", "timestamptz")
    .addColumn("concurrency_key", "text")
    .addColumn("consecutive_failures", "int2", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("agent_job_kind_check", sql`kind in ('fork_upkeep', 'dev_run')`)
    .execute()

  await fkIndexes(db, "agent_job", ["project_id"])
  await sql`
    create index agent_job_next_run_at_idx on agent_job (next_run_at) where enabled = true
  `.execute(db)

  await db.schema
    .createTable("agent_job_run")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("agent_job_id", "uuid", (col) =>
      col.references("agent_job.id").onDelete("cascade").notNull(),
    )
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("set null"),
    )
    .addColumn("state", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("lease_expires_at", "timestamptz")
    .addColumn("attempt", "int2", (col) => col.notNull().defaultTo(0))
    .addColumn("pr_url", "text")
    .addColumn("tests_passed", "boolean")
    .addColumn("error", "text")
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "agent_job_run_state_check",
      sql`state in ('queued', 'leased', 'running', 'succeeded', 'failed', 'conflict', 'cancelled')`,
    )
    .execute()

  await fkIndexes(db, "agent_job_run", ["agent_job_id", "agent_session_id"])
  await sql`
    create index agent_job_run_state_created_idx on agent_job_run (state, created_at)
  `.execute(db)
  await sql`
    create index agent_job_run_lease_idx on agent_job_run (lease_expires_at)
      where lease_expires_at is not null
  `.execute(db)

  await db.schema
    .createTable("agent_usage")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("cascade"))
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("set null"),
    )
    .addColumn("agent_turn_id", "uuid", (col) =>
      col.references("agent_turn.id").onDelete("set null"),
    )
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("input_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("cache_read_input_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("cache_creation_input_tokens", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("billed_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("occurred_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("agent_usage_source_check", sql`source in ('gateway', 'sdk_estimate')`)
    .execute()

  await fkIndexes(db, "agent_usage", ["project_id", "agent_session_id", "agent_turn_id"])
  await sql`
    create index agent_usage_org_occurred_idx on agent_usage (organization_id, occurred_at)
  `.execute(db)

  await db.schema
    .createTable("upstream_sync_run")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("repository_id", "uuid", (col) =>
      col.references("repository.id").onDelete("cascade").notNull(),
    )
    .addColumn("agent_job_run_id", "uuid", (col) =>
      col.references("agent_job_run.id").onDelete("set null"),
    )
    .addColumn("branch", "text", (col) => col.notNull())
    .addColumn("upstream_sha", "text")
    .addColumn("fork_sha", "text")
    .addColumn("behind_by", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("ahead_by", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("merge_type", "text")
    .addColumn("outcome", "text", (col) => col.notNull().defaultTo("up_to_date"))
    .addColumn("pull_request_number", "integer")
    .addColumn("pull_request_url", "text")
    .addColumn("cost_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "upstream_sync_run_merge_type_check",
      sql`merge_type is null or merge_type in ('merge', 'fast_forward', 'none')`,
    )
    .addCheckConstraint(
      "upstream_sync_run_outcome_check",
      sql`outcome in ('up_to_date', 'pr_opened', 'conflict', 'failed')`,
    )
    .execute()

  await fkIndexes(db, "upstream_sync_run", ["repository_id", "agent_job_run_id"])
  await sql`
    create index upstream_sync_run_repo_branch_created_idx on upstream_sync_run
      (repository_id, branch, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("project_update_suggestion")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("upstream_sync_run_id", "uuid", (col) =>
      col.references("upstream_sync_run.id").onDelete("cascade").notNull(),
    )
    .addColumn("resolved_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("summary", "text")
    .addColumn("resolved_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("project_update_suggestion_project_run_key", [
      "project_id",
      "upstream_sync_run_id",
    ])
    .addCheckConstraint(
      "project_update_suggestion_status_check",
      sql`status in ('pending', 'accepted', 'dismissed', 'applied')`,
    )
    .execute()

  await fkIndexes(db, "project_update_suggestion", [
    "project_id",
    "upstream_sync_run_id",
    "resolved_by_user_id",
  ])

  await db.schema
    .createTable("deployment")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("restrict").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("git_ref", "text")
    .addColumn("git_sha", "text", (col) => col.notNull())
    .addColumn("pr_number", "integer")
    .addColumn("image_uri", "text")
    .addColumn("knative_revision", "text")
    .addColumn("url", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("runtime_class", "text", (col) => col.notNull().defaultTo("kata-fc"))
    .addColumn("container_concurrency", "integer", (col) => col.notNull().defaultTo(20))
    .addColumn("memory_mb", "integer", (col) => col.notNull().defaultTo(1024))
    .addColumn("max_duration_s", "integer", (col) => col.notNull().defaultTo(300))
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("deployment_kind_check", sql`kind in ('production', 'preview', 'branch')`)
    .addCheckConstraint(
      "deployment_status_check",
      sql`status in ('queued', 'building', 'deploying', 'ready', 'error', 'torn_down')`,
    )
    .addCheckConstraint(
      "deployment_runtime_class_check",
      sql`runtime_class in ('kata-fc', 'kata-clh')`,
    )
    .execute()

  await sql`
    create index deployment_project_kind_created_idx on deployment
      (project_id, kind, created_at desc)
  `.execute(db)
  await sql`
    create unique index deployment_preview_pr_key on deployment (project_id, pr_number)
      where kind = 'preview' and status <> 'torn_down' and deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("deployment_build")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("deployment_id", "uuid", (col) =>
      col.references("deployment.id").onDelete("cascade").notNull(),
    )
    .addColumn("builder", "text", (col) => col.notNull().defaultTo("buildkit"))
    .addColumn("cache_key", "text")
    .addColumn("log_object_key", "text")
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("exit_code", "integer")
    .addColumn("bytes_pushed", "bigint")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "deployment_build", ["deployment_id"])

  await db.schema
    .createTable("compute_instance")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("deployment_id", "uuid", (col) =>
      col.references("deployment.id").onDelete("cascade").notNull(),
    )
    .addColumn("node_name", "text", (col) => col.notNull())
    .addColumn("pod_uid", "text", (col) => col.notNull())
    .addColumn("cgroup_path", "text")
    .addColumn("memory_mb", "integer")
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("stopped_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("compute_instance_pod_uid_key", ["pod_uid"])
    .execute()

  await fkIndexes(db, "compute_instance", ["deployment_id", "node_name"])

  await db.schema
    .createTable("sandbox")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("pod_name", "text")
    .addColumn("namespace", "text")
    .addColumn("hostname", "text")
    .addColumn("runtime_class", "text", (col) => col.notNull().defaultTo("kata-clh"))
    .addColumn("pvc_name", "text")
    .addColumn("state", "text", (col) => col.notNull().defaultTo("starting"))
    .addColumn("last_activity_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("idle_timeout_s", "integer", (col) => col.notNull().defaultTo(900))
    .addColumn("always_on", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("sandbox_hostname_key", ["hostname"])
    .addCheckConstraint(
      "sandbox_runtime_class_check",
      sql`runtime_class in ('kata-fc', 'kata-clh')`,
    )
    .addCheckConstraint(
      "sandbox_state_check",
      sql`state in ('starting', 'running', 'idle', 'stopped', 'failed')`,
    )
    .execute()

  await fkIndexes(db, "sandbox", ["project_id", "user_id"])
  await sql`
    create index sandbox_reaper_idx on sandbox (state, last_activity_at) where always_on = false
  `.execute(db)

  await db.schema
    .createTable("workflow")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("runtime", "text", (col) => col.notNull().defaultTo("node"))
    .addColumn("queue_name", "text", (col) => col.notNull())
    .addColumn("current_version_id", "uuid")
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("workflow_runtime_check", sql`runtime in ('node', 'python')`)
    .execute()

  await fkIndexes(db, "workflow", ["project_id", "current_version_id"])
  await sql`
    create unique index workflow_project_slug_live_key on workflow (project_id, slug)
      where deleted_at is null
  `.execute(db)

  await db.schema
    .createTable("workflow_version")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("workflow_id", "uuid", (col) =>
      col.references("workflow.id").onDelete("cascade").notNull(),
    )
    .addColumn("created_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("version", "integer", (col) => col.notNull())
    .addColumn("graph", "jsonb", (col) => col.notNull())
    .addColumn("graph_sha256", "text", (col) => col.notNull())
    .addColumn("compiled_commit_sha", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("workflow_version_workflow_version_key", ["workflow_id", "version"])
    .execute()

  await fkIndexes(db, "workflow_version", ["workflow_id", "created_by_user_id"])

  await sql`
    alter table workflow add constraint workflow_current_version_id_fkey
      foreign key (current_version_id) references workflow_version (id) on delete set null
  `.execute(db)

  await db.schema
    .createTable("workflow_schedule")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("workflow_id", "uuid", (col) =>
      col.references("workflow.id").onDelete("cascade").notNull(),
    )
    .addColumn("cron_expression", "text", (col) => col.notNull())
    .addColumn("timezone", "text", (col) => col.notNull().defaultTo("UTC"))
    .addColumn("next_run_at", "timestamptz")
    .addColumn("last_run_at", "timestamptz")
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "workflow_schedule", ["workflow_id"])
  await sql`
    create index workflow_schedule_next_run_at_idx on workflow_schedule (next_run_at)
      where enabled = true
  `.execute(db)

  await db.schema
    .createTable("workflow_run")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("workflow_id", "uuid", (col) =>
      col.references("workflow.id").onDelete("cascade").notNull(),
    )
    .addColumn("workflow_version_id", "uuid", (col) =>
      col.references("workflow_version.id").onDelete("restrict"),
    )
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("queue_job_id", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("attempt", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("error", "jsonb")
    .addColumn("bytes_enqueued", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("valkey_dwell_ms", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "workflow_run_trigger_type_check",
      sql`trigger_type in ('cron', 'webhook', 'manual', 'event')`,
    )
    .addCheckConstraint(
      "workflow_run_status_check",
      sql`status in ('queued', 'running', 'succeeded', 'failed', 'dead_lettered', 'cancelled')`,
    )
    .execute()

  await fkIndexes(db, "workflow_run", ["workflow_id", "workflow_version_id", "queue_job_id"])
  await sql`
    create index workflow_run_workflow_created_idx on workflow_run (workflow_id, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("workflow_run_step")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("workflow_run_id", "uuid", (col) =>
      col.references("workflow_run.id").onDelete("cascade").notNull(),
    )
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("node_type", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("input", "jsonb")
    .addColumn("output", "jsonb")
    .addColumn("log_ref", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "workflow_run_step_status_check",
      sql`status in ('queued', 'running', 'succeeded', 'failed', 'skipped')`,
    )
    .execute()

  await fkIndexes(db, "workflow_run_step", ["workflow_run_id"])

  await db.schema
    .createTable("workflow_job_edit_audit")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("workflow_run_id", "uuid", (col) =>
      col.references("workflow_run.id").onDelete("restrict").notNull(),
    )
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("actor_user_id", "uuid", (col) => col.references("user.id").onDelete("restrict"))
    .addColumn("queue_job_id", "text", (col) => col.notNull())
    .addColumn("job_state_at_edit", "text", (col) => col.notNull())
    .addColumn("before", "jsonb")
    .addColumn("after", "jsonb")
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "workflow_job_edit_audit", [
    "workflow_run_id",
    "organization_id",
    "actor_user_id",
  ])

  await db.schema
    .createTable("tenant_queue")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    .addColumn("queue_name", "text", (col) => col.notNull())
    .addColumn("driver", "text", (col) => col.notNull().defaultTo("bullmq"))
    .addColumn("max_memory_bytes", "bigint")
    .addColumn("max_concurrency", "integer")
    .addColumn("last_arrival_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("tenant_queue_project_queue_name_key", ["project_id", "queue_name"])
    .addCheckConstraint("tenant_queue_driver_check", sql`driver in ('bullmq', 'celery')`)
    .execute()

  await fkIndexes(db, "tenant_queue", ["project_id"])

  await db.schema
    .createTable("price_book")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("version", "integer", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("currency", sql`char(3)`, (col) => col.notNull().defaultTo("USD"))
    .addColumn("overhead_bps", "integer", (col) => col.notNull().defaultTo(1200))
    .addColumn("effective_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("price_book_version_key", ["version"])
    .addCheckConstraint("price_book_overhead_bps_check", sql`overhead_bps between 0 and 100000`)
    .execute()

  await fkIndexes(db, "price_book", ["effective_at"])

  await db.schema
    .createTable("price_book_item")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("price_book_id", "uuid", (col) =>
      col.references("price_book.id").onDelete("cascade").notNull(),
    )
    .addColumn("dimension", "text", (col) => col.notNull())
    .addColumn("unit_micro_usd", sql`numeric(38, 9)`, (col) => col.notNull())
    .addColumn("included_free_quantity", sql`numeric(38, 9)`, (col) => col.notNull().defaultTo(0))
    .addColumn("rounding", "text", (col) => col.notNull().defaultTo("half_even"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("price_book_item_book_dimension_key", ["price_book_id", "dimension"])
    .addCheckConstraint(
      "price_book_item_dimension_check",
      sql`dimension in (${sql.raw(DIMENSIONS)})`,
    )
    .addCheckConstraint(
      "price_book_item_rounding_check",
      sql`rounding in ('half_even', 'up', 'down')`,
    )
    .execute()

  await fkIndexes(db, "price_book_item", ["price_book_id"])

  await db.schema
    .createTable("payment_method")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("stripe_payment_method_id", "text", (col) => col.notNull())
    .addColumn("brand", "text")
    .addColumn("last4", "text")
    .addColumn("exp_month", "int2")
    .addColumn("exp_year", "int2")
    .addColumn("is_default", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("detached_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("payment_method_stripe_id_key", ["stripe_payment_method_id"])
    .execute()

  await fkIndexes(db, "payment_method", ["organization_id"])

  await db.schema
    .createTable("stripe_customer")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("stripe_customer_id", "text", (col) => col.notNull())
    .addColumn("default_payment_method_id", "uuid", (col) =>
      col.references("payment_method.id").onDelete("set null"),
    )
    .addColumn("auto_reload_enabled", "boolean", (col) => col.notNull().defaultTo(sql`true`))
    .addColumn("auto_reload_threshold_micro_usd", "bigint", (col) =>
      col.notNull().defaultTo(2000000),
    )
    .addColumn("auto_reload_amount_micro_usd", "bigint", (col) => col.notNull().defaultTo(10000000))
    .addColumn("lifetime_min_topup_used", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("stripe_customer_organization_id_key", ["organization_id"])
    .addUniqueConstraint("stripe_customer_stripe_customer_id_key", ["stripe_customer_id"])
    .execute()

  await fkIndexes(db, "stripe_customer", ["default_payment_method_id"])

  await db.schema
    .createTable("credit_account")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("currency", sql`char(3)`, (col) => col.notNull().defaultTo("USD"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("credit_account_organization_kind_key", ["organization_id", "kind"])
    .addCheckConstraint(
      "credit_account_kind_check",
      sql`kind in ('user_credit', 'platform_revenue', 'promotional', 'stripe_clearing')`,
    )
    .execute()

  await fkIndexes(db, "credit_account", ["organization_id"])

  await db.schema
    .createTable("credit_transaction")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("idempotency_key", "text", (col) => col.notNull())
    .addColumn("reference_type", "text")
    .addColumn("reference_id", "uuid")
    .addColumn("description", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("credit_transaction_idempotency_key_key", ["idempotency_key"])
    .addCheckConstraint(
      "credit_transaction_kind_check",
      sql`kind in ('topup', 'usage', 'overhead', 'refund', 'promo', 'adjustment', 'hold_settle')`,
    )
    .execute()

  await fkIndexes(db, "credit_transaction", ["kind"])
  await sql`
    create index credit_transaction_org_created_idx on credit_transaction
      (organization_id, created_at desc)
  `.execute(db)

  await db.schema
    .createTable("credit_ledger_entry")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("credit_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("restrict").notNull(),
    )
    .addColumn("credit_account_id", "uuid", (col) =>
      col.references("credit_account.id").onDelete("restrict").notNull(),
    )
    .addColumn("amount_micro_usd", "bigint", (col) => col.notNull())
    .addColumn("seq", "bigint", (col) => col.notNull().generatedAlwaysAsIdentity())
    .addColumn("compacted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "credit_ledger_entry", ["credit_transaction_id", "credit_account_id"])
  await sql`
    create index credit_ledger_entry_uncompacted_idx on credit_ledger_entry
      (credit_account_id) where compacted_at is null
  `.execute(db)

  await db.schema
    .createTable("credit_balance_cache")
    .addColumn("credit_account_id", "uuid", (col) =>
      col.references("credit_account.id").onDelete("cascade").primaryKey(),
    )
    .addColumn("balance_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("compacted_through", "timestamptz")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable("credit_hold")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("credit_account_id", "uuid", (col) =>
      col.references("credit_account.id").onDelete("restrict").notNull(),
    )
    .addColumn("settled_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("set null"),
    )
    .addColumn("resource_type", "text", (col) => col.notNull())
    .addColumn("resource_id", "uuid")
    .addColumn("amount_micro_usd", "bigint", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "credit_hold_status_check",
      sql`status in ('active', 'settled', 'released', 'expired')`,
    )
    .execute()

  await fkIndexes(db, "credit_hold", [
    "organization_id",
    "credit_account_id",
    "settled_transaction_id",
  ])
  await sql`
    create index credit_hold_status_expires_idx on credit_hold (status, expires_at)
  `.execute(db)

  await sql`
    create table usage_event (
      id uuid not null,
      organization_id uuid not null references organization (id) on delete restrict,
      project_id uuid references project (id) on delete restrict,
      resource_type text not null,
      resource_id uuid,
      dimension text not null,
      quantity numeric(38, 9) not null,
      occurred_at timestamptz not null,
      window_start timestamptz,
      window_end timestamptz,
      node_id text,
      pod_uid text,
      source text not null,
      external_id text not null,
      rated_at timestamptz,
      ingested_at timestamptz not null default now(),
      constraint usage_event_pkey primary key (id, occurred_at),
      constraint usage_event_source_external_id_key unique (source, external_id, occurred_at),
      constraint usage_event_dimension_check check (dimension in (${sql.raw(DIMENSIONS)}))
    ) partition by range (occurred_at)
  `.execute(db)

  await sql`
    do $$
    declare d date := current_date - 1;
    begin
      while d < current_date + 7 loop
        execute format(
          'create table if not exists usage_event_%s partition of usage_event
             for values from (%L) to (%L)',
          to_char(d, 'YYYYMMDD'),
          (d::timestamp at time zone 'UTC'),
          ((d + 1)::timestamp at time zone 'UTC')
        );
        d := d + 1;
      end loop;
    end $$
  `.execute(db)

  await sql`
    create index usage_event_org_occurred_idx on usage_event (organization_id, occurred_at)
  `.execute(db)
  await sql`
    create index usage_event_project_occurred_idx on usage_event (project_id, occurred_at)
  `.execute(db)
  await sql`
    create index usage_event_occurred_at_brin_idx on usage_event using brin (occurred_at)
  `.execute(db)
  await sql`
    create index usage_event_unrated_idx on usage_event (rated_at, occurred_at)
  `.execute(db)

  await db.schema
    .createTable("usage_rollup")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("rated_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("set null"),
    )
    .addColumn("dimension", "text", (col) => col.notNull())
    .addColumn("bucket", "text", (col) => col.notNull())
    .addColumn("bucket_start", "timestamptz", (col) => col.notNull())
    .addColumn("quantity", sql`numeric(38, 9)`, (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("usage_rollup_bucket_check", sql`bucket in ('minute', 'hour', 'day')`)
    .addCheckConstraint("usage_rollup_dimension_check", sql`dimension in (${sql.raw(DIMENSIONS)})`)
    .execute()

  await fkIndexes(db, "usage_rollup", ["project_id", "rated_transaction_id"])
  await sql`
    create unique index usage_rollup_grain_key on usage_rollup
      (organization_id, project_id, dimension, bucket, bucket_start) nulls not distinct
  `.execute(db)
  await sql`
    create index usage_rollup_org_bucket_idx on usage_rollup
      (organization_id, bucket, bucket_start)
  `.execute(db)

  await db.schema
    .createTable("statement")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("period_start", "timestamptz", (col) => col.notNull())
    .addColumn("period_end", "timestamptz", (col) => col.notNull())
    .addColumn("subtotal_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("overhead_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("total_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("overhead_bps", "integer", (col) => col.notNull().defaultTo(1200))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("draft"))
    .addColumn("finalized_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("statement_org_period_key", ["organization_id", "period_start"])
    .addCheckConstraint("statement_status_check", sql`status in ('draft', 'finalized', 'void')`)
    .execute()

  await fkIndexes(db, "statement", ["organization_id"])

  await db.schema
    .createTable("statement_line_item")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("statement_id", "uuid", (col) =>
      col.references("statement.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("restrict"))
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("usage"))
    .addColumn("dimension", "text")
    .addColumn("quantity", sql`numeric(38, 9)`, (col) => col.notNull().defaultTo(0))
    .addColumn("unit_micro_usd", sql`numeric(38, 9)`)
    .addColumn("amount_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("description", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("statement_line_item_kind_check", sql`kind in ('usage', 'overhead')`)
    .addCheckConstraint(
      "statement_line_item_dimension_check",
      sql`dimension is null or dimension in (${sql.raw(DIMENSIONS)})`,
    )
    .execute()

  await fkIndexes(db, "statement_line_item", ["statement_id", "project_id"])

  await db.schema
    .createTable("topup")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("credit_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("set null"),
    )
    .addColumn("stripe_payment_intent_id", "text")
    .addColumn("stripe_checkout_session_id", "text")
    .addColumn("amount_micro_usd", "bigint", (col) => col.notNull())
    .addColumn("credited_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("initiated_by", "text", (col) => col.notNull().defaultTo("user"))
    .addColumn("failure_code", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("topup_stripe_payment_intent_id_key", ["stripe_payment_intent_id"])
    .addUniqueConstraint("topup_stripe_checkout_session_id_key", ["stripe_checkout_session_id"])
    .addCheckConstraint(
      "topup_status_check",
      sql`status in ('pending', 'processing', 'succeeded', 'failed', 'canceled')`,
    )
    .addCheckConstraint("topup_initiated_by_check", sql`initiated_by in ('user', 'auto_reload')`)
    .execute()

  await fkIndexes(db, "topup", ["organization_id", "credit_transaction_id"])

  await db.schema
    .createTable("stripe_webhook_event")
    .addColumn("stripe_event_id", "text", (col) => col.primaryKey())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("received_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("processed_at", "timestamptz")
    .addColumn("error", "text")
    .execute()

  await sql`
    create index stripe_webhook_event_type_received_idx on stripe_webhook_event
      (type, received_at desc)
  `.execute(db)
  await sql`
    create index stripe_webhook_event_unprocessed_idx on stripe_webhook_event (received_at)
      where processed_at is null
  `.execute(db)

  await db.schema
    .createTable("refund")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("topup_id", "uuid", (col) =>
      col.references("topup.id").onDelete("restrict").notNull(),
    )
    .addColumn("clawback_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("set null"),
    )
    .addColumn("stripe_refund_id", "text", (col) => col.notNull())
    .addColumn("amount_micro_usd", "bigint", (col) => col.notNull())
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("refund_stripe_refund_id_key", ["stripe_refund_id"])
    .execute()

  await fkIndexes(db, "refund", ["topup_id", "clawback_transaction_id"])

  await db.schema
    .createTable("oauth_client")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("owner_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("cascade").notNull(),
    )
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("logo_url", "text")
    .addColumn("homepage_url", "text", (col) => col.notNull())
    .addColumn("client_type", "text", (col) => col.notNull())
    .addColumn("is_first_party", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("is_verified", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("default_scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "oauth_client_client_type_check",
      sql`client_type in ('confidential', 'public')`,
    )
    .addCheckConstraint("oauth_client_status_check", sql`status in ('active', 'suspended')`)
    .execute()

  await fkIndexes(db, "oauth_client", ["owner_user_id", "organization_id"])

  await db.schema
    .createTable("oauth_client_redirect_uri")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("oauth_client_id", "uuid", (col) =>
      col.references("oauth_client.id").onDelete("cascade").notNull(),
    )
    .addColumn("uri", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("oauth_client_redirect_uri_client_uri_key", ["oauth_client_id", "uri"])
    .execute()

  await fkIndexes(db, "oauth_client_redirect_uri", ["oauth_client_id", "uri"])

  await db.schema
    .createTable("oauth_client_secret")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("oauth_client_id", "uuid", (col) =>
      col.references("oauth_client.id").onDelete("cascade").notNull(),
    )
    .addColumn("secret_hash", "text", (col) => col.notNull())
    .addColumn("last_four", "text", (col) => col.notNull())
    .addColumn("last_used_at", "timestamptz")
    .addColumn("expires_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "oauth_client_secret", ["oauth_client_id"])

  await db.schema
    .createTable("oauth_grant")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("oauth_client_id", "uuid", (col) =>
      col.references("oauth_client.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "oauth_grant", ["oauth_client_id", "user_id", "organization_id"])
  await sql`
    create unique index oauth_grant_live_key on oauth_grant
      (oauth_client_id, user_id, organization_id) where revoked_at is null
  `.execute(db)

  await db.schema
    .createTable("oauth_authorization_code")
    .addColumn("code_hash", "text", (col) => col.primaryKey())
    .addColumn("oauth_client_id", "uuid", (col) =>
      col.references("oauth_client.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("oauth_grant_id", "uuid", (col) =>
      col.references("oauth_grant.id").onDelete("cascade").notNull(),
    )
    .addColumn("redirect_uri", "text", (col) => col.notNull())
    .addColumn("scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("code_challenge", "text", (col) => col.notNull())
    .addColumn("code_challenge_method", "text", (col) => col.notNull().defaultTo("S256"))
    .addColumn("nonce", "text")
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "oauth_authorization_code_challenge_method_check",
      sql`code_challenge_method = 'S256'`,
    )
    .execute()

  await fkIndexes(db, "oauth_authorization_code", [
    "oauth_client_id",
    "user_id",
    "organization_id",
    "oauth_grant_id",
    "expires_at",
  ])

  await db.schema
    .createTable("oauth_access_token")
    .addColumn("token_hash", "text", (col) => col.primaryKey())
    .addColumn("oauth_grant_id", "uuid", (col) =>
      col.references("oauth_grant.id").onDelete("cascade").notNull(),
    )
    .addColumn("oauth_client_id", "uuid", (col) =>
      col.references("oauth_client.id").onDelete("cascade").notNull(),
    )
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("scopes", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn("resource", "text")
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "oauth_access_token", [
    "oauth_grant_id",
    "oauth_client_id",
    "user_id",
    "expires_at",
  ])

  await db.schema
    .createTable("oauth_refresh_token")
    .addColumn("token_hash", "text", (col) => col.primaryKey())
    .addColumn("oauth_grant_id", "uuid", (col) =>
      col.references("oauth_grant.id").onDelete("cascade").notNull(),
    )
    .addColumn("family_id", "uuid", (col) => col.notNull())
    .addColumn("parent_token_hash", "text")
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await fkIndexes(db, "oauth_refresh_token", ["oauth_grant_id", "family_id", "expires_at"])

  await db.schema
    .createTable("oauth_signing_key")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("kid", "text", (col) => col.notNull())
    .addColumn("algorithm", "text", (col) => col.notNull().defaultTo("ES256"))
    .addColumn("public_jwk", "jsonb", (col) => col.notNull())
    .addColumn("private_key_ciphertext", "text", (col) => col.notNull())
    .addColumn("private_key_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("private_key_kms_key_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("next"))
    .addColumn("rotated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("oauth_signing_key_kid_key", ["kid"])
    .addCheckConstraint("oauth_signing_key_algorithm_check", sql`algorithm = 'ES256'`)
    .addCheckConstraint(
      "oauth_signing_key_status_check",
      sql`status in ('active', 'next', 'retired')`,
    )
    .execute()

  await sql`
    create function sproutos_append_only() returns trigger as $$
    begin
      raise exception '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
    end;
    $$ language plpgsql
  `.execute(db)

  await sql`
    create function sproutos_ledger_entry_guard() returns trigger as $$
    begin
      if TG_OP = 'DELETE' then
        raise exception 'credit_ledger_entry is append-only; DELETE is not permitted';
      end if;
      if (NEW.id, NEW.credit_transaction_id, NEW.credit_account_id, NEW.amount_micro_usd,
          NEW.seq, NEW.created_at)
         is distinct from
         (OLD.id, OLD.credit_transaction_id, OLD.credit_account_id, OLD.amount_micro_usd,
          OLD.seq, OLD.created_at) then
        raise exception 'credit_ledger_entry rows are immutable apart from compacted_at';
      end if;
      if OLD.compacted_at is not null or NEW.compacted_at is null then
        raise exception 'credit_ledger_entry.compacted_at may only be set once, from null';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db)

  await sql`
    create function sproutos_assert_transaction_balanced() returns trigger as $$
    declare
      total bigint;
    begin
      select coalesce(sum(amount_micro_usd), 0) into total
        from credit_ledger_entry where credit_transaction_id = NEW.credit_transaction_id;
      if total <> 0 then
        raise exception 'credit_transaction % legs sum to % micro-USD, expected 0',
          NEW.credit_transaction_id, total;
      end if;
      return null;
    end;
    $$ language plpgsql
  `.execute(db)

  await sql`
    create trigger audit_log_append_only before update or delete on audit_log
      for each row execute function sproutos_append_only()
  `.execute(db)

  await sql`
    create trigger workflow_job_edit_audit_append_only
      before update or delete on workflow_job_edit_audit
      for each row execute function sproutos_append_only()
  `.execute(db)

  await sql`
    create trigger credit_ledger_entry_guard before update or delete on credit_ledger_entry
      for each row execute function sproutos_ledger_entry_guard()
  `.execute(db)

  await sql`
    create constraint trigger credit_ledger_entry_balanced after insert on credit_ledger_entry
      deferrable initially deferred
      for each row execute function sproutos_assert_transaction_balanced()
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop trigger if exists credit_ledger_entry_balanced on credit_ledger_entry`.execute(db)
  await sql`drop trigger if exists credit_ledger_entry_guard on credit_ledger_entry`.execute(db)
  await sql`
    drop trigger if exists workflow_job_edit_audit_append_only on workflow_job_edit_audit
  `.execute(db)
  await sql`drop trigger if exists audit_log_append_only on audit_log`.execute(db)

  await sql`alter table workflow drop constraint if exists workflow_current_version_id_fkey`.execute(
    db,
  )

  for (const table of TABLE_ORDER.toReversed()) {
    await db.schema.dropTable(table).ifExists().execute()
  }

  await sql`drop function if exists sproutos_assert_transaction_balanced()`.execute(db)
  await sql`drop function if exists sproutos_ledger_entry_guard()`.execute(db)
  await sql`drop function if exists sproutos_append_only()`.execute(db)
}
