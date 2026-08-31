import { sql, type Kysely } from "kysely"

/** Every Neon branch created for an agent keeps a durable owner until provider cleanup succeeds. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table database_branch
      add column provider_branch_name text,
      add column provisioning_state text not null default 'active',
      add column reservation_token uuid,
      add column cleanup_attempts smallint not null default 0,
      add column cleanup_retry_at timestamptz,
      add column cleanup_error text,
      add column created_by_user_id uuid references "user"(id) on delete set null,
      add column deleted_at timestamptz;

    update database_branch set provider_branch_name = name;

    alter table database_branch
      drop constraint database_branch_kind_check,
      add constraint database_branch_kind_check
        check (kind in ('primary', 'dev', 'user', 'upkeep', 'preview')),
      add constraint database_branch_provisioning_state_check
        check (provisioning_state in ('provisioning', 'active', 'cleanup', 'deleted')),
      add constraint database_branch_reservation_state_check
        check (
          (provisioning_state in ('active', 'deleted') and reservation_token is null)
          or (provisioning_state in ('provisioning', 'cleanup') and reservation_token is not null)
        ),
      add constraint database_branch_instance_provider_name_key
        unique (database_instance_id, provider_branch_name);

    create index database_branch_cleanup_retry_idx
      on database_branch (cleanup_retry_at, expires_at)
      where expires_at is not null and is_protected = false;

    do $$
    begin
      if exists (
        select database_branch_id
        from sandbox
        where database_branch_id is not null
        group by database_branch_id
        having count(*) > 1
      ) then
        raise exception using
          message = 'cannot assign one database branch to multiple sandboxes',
          hint = 'repair duplicate sandbox.database_branch_id owners before retrying this migration';
      end if;
    end
    $$;
  `.execute(db)

  await db.schema
    .createTable("sandbox_database_branch")
    .addColumn("sandbox_id", "uuid", (col) =>
      col.references("sandbox.id").onDelete("cascade").notNull(),
    )
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade").notNull(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("sandbox_database_branch_pkey", ["sandbox_id", "database_branch_id"])
    .addUniqueConstraint("sandbox_database_branch_branch_key", ["database_branch_id"])
    .execute()

  await db.schema
    .createTable("neon_branch_metering_state")
    .addColumn("database_branch_id", "uuid", (col) =>
      col.primaryKey().references("database_branch.id").onDelete("cascade"),
    )
    .addColumn("metered_through", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex("neon_branch_metering_state_metered_through_idx")
    .on("neon_branch_metering_state")
    .column("metered_through")
    .execute()

  // The previous meter observed one Neon project at a time. Carry that watermark onto every
  // existing branch so switching to provider branch history cannot invoice the same hours twice.
  await sql`
    insert into neon_branch_metering_state (database_branch_id, metered_through)
    select database_branch.id, neon_metering_state.metered_through
    from database_branch
    inner join database_instance
      on database_instance.id = database_branch.database_instance_id
    inner join neon_metering_state
      on neon_metering_state.backend_service_id = database_instance.backend_service_id
  `.execute(db)

  await db.schema
    .createIndex("sandbox_database_branch_sandbox_id_idx")
    .on("sandbox_database_branch")
    .column("sandbox_id")
    .execute()

  await sql`
    insert into sandbox_database_branch (sandbox_id, database_branch_id)
    select id, database_branch_id
    from sandbox
    where database_branch_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("neon_branch_metering_state").execute()
  await db.schema.dropTable("sandbox_database_branch").execute()
  await sql`
    drop index database_branch_cleanup_retry_idx;
    alter table database_branch
      drop constraint database_branch_instance_provider_name_key,
      drop constraint database_branch_reservation_state_check,
      drop constraint database_branch_provisioning_state_check,
      drop constraint database_branch_kind_check,
      add constraint database_branch_kind_check
        check (kind in ('primary', 'dev', 'upkeep', 'preview')),
      drop column deleted_at,
      drop column created_by_user_id,
      drop column cleanup_error,
      drop column cleanup_retry_at,
      drop column cleanup_attempts,
      drop column reservation_token,
      drop column provisioning_state,
      drop column provider_branch_name;
  `.execute(db)
}
