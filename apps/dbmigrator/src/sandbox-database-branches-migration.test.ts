import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up } from "./migrations/2026_11_10_00_00_00_sandbox_database_branches"

const databaseReachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

afterAll(async () => {
  await db.destroy()
})

describe.skipIf(!databaseReachable)("sandbox database branch ownership migration", () => {
  it("fails before backfill when two sandboxes claim one default branch", async () => {
    const schema = `sandbox_branch_owner_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)
    try {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
          await sql`create table "user" (id uuid primary key)`.execute(trx)
          await sql`create table database_instance (id uuid primary key)`.execute(trx)
          await sql`
            create table database_branch (
              id uuid primary key,
              database_instance_id uuid not null references database_instance(id),
              name text not null,
              kind text not null default 'primary',
              is_protected boolean not null default false,
              expires_at timestamptz,
              constraint database_branch_kind_check
                check (kind in ('primary', 'dev', 'upkeep', 'preview'))
            )
          `.execute(trx)
          await sql`
            create table sandbox (
              id uuid primary key,
              database_branch_id uuid references database_branch(id)
            )
          `.execute(trx)
          await sql`
            insert into database_instance (id)
            values ('00000000-0000-0000-0000-000000000001')
          `.execute(trx)
          await sql`
            insert into database_branch (id, database_instance_id, name)
            values (
              '00000000-0000-0000-0000-000000000002',
              '00000000-0000-0000-0000-000000000001',
              'shared-default'
            )
          `.execute(trx)
          await sql`
            insert into sandbox (id, database_branch_id) values
              (
                '00000000-0000-0000-0000-000000000003',
                '00000000-0000-0000-0000-000000000002'
              ),
              (
                '00000000-0000-0000-0000-000000000004',
                '00000000-0000-0000-0000-000000000002'
              )
          `.execute(trx)

          await up(trx as unknown as Kysely<unknown>)
        }),
      ).rejects.toThrow("cannot assign one database branch to multiple sandboxes")

      const rolledBack = await sql<{ relation: string | null; columnPresent: boolean }>`
        select
          to_regclass(${`${schema}.sandbox_database_branch`})::text as relation,
          exists (
            select 1 from information_schema.columns
            where table_schema = ${schema}
              and table_name = 'database_branch'
              and column_name = 'provider_branch_name'
          ) as "columnPresent"
      `.execute(db)
      expect(rolledBack.rows[0]).toEqual({ relation: null, columnPresent: false })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
