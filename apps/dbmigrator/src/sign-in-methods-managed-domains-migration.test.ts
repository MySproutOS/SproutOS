import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import {
  down as downSignInMethods,
  up as upSignInMethods,
} from "./migrations/2026_11_20_00_00_00_user_sign_in_methods"
import {
  down as downManagedDomains,
  up as upManagedDomains,
} from "./migrations/2026_11_21_00_00_00_managed_custom_domains"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

afterAll(async () => db.destroy())

describe.skipIf(!reachable)("sign-in methods and managed-domain migrations", () => {
  it("migrates up and down with durable constraints and safe backfill", async () => {
    const schema = `identity_domain_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)

    try {
      await db.transaction().execute(async (transaction) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(transaction)
        await sql`create table "user" (
          id uuid primary key,
          email text not null,
          github_login text,
          github_user_id bigint
        )`.execute(transaction)
        await sql`create table session (
          session_key text primary key,
          user_id uuid not null references "user"(id),
          expires timestamptz not null
        )`.execute(transaction)
        await sql`create table account (
          id uuid primary key,
          user_id uuid not null references "user"(id),
          provider text not null
        )`.execute(transaction)
        await sql`create table organization (
          id uuid primary key,
          owner_user_id uuid not null references "user"(id)
        )`.execute(transaction)
        await sql`create table custom_domain (
          id uuid primary key,
          organization_id uuid not null references organization(id),
          deleted_at timestamptz
        )`.execute(transaction)

        await sql`insert into "user" values (
          '00000000-0000-4000-8000-000000000001',
          'owner@example.test', 'renamed-handle', 42
        )`.execute(transaction)
        await sql`insert into session values (
          'session-hash', '00000000-0000-4000-8000-000000000001', now() + interval '1 hour'
        )`.execute(transaction)
        await sql`insert into account values (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001', 'github'
        )`.execute(transaction)
        await sql`insert into organization values (
          '00000000-0000-4000-8000-000000000003',
          '00000000-0000-4000-8000-000000000001'
        )`.execute(transaction)

        const migrationDb = transaction as unknown as Kysely<unknown>
        await upSignInMethods(migrationDb)
        await upManagedDomains(migrationDb)

        const backfilled = await sql<{ displayIdentity: string }>`
          select display_identity as "displayIdentity" from account
        `.execute(transaction)
        expect(backfilled.rows[0]?.displayIdentity).toBe("renamed-handle")

        await sql`insert into managed_custom_domain_policy (
          id, suffix, organization_id, created_by_user_id, updated_by_user_id
        ) values (
          '00000000-0000-4000-8000-000000000004', 'sproutos.biz',
          '00000000-0000-4000-8000-000000000003',
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000001'
        )`.execute(transaction)
        const duplicate = await sql<{ id: string }>`insert into managed_custom_domain_policy (
            id, suffix, organization_id, created_by_user_id, updated_by_user_id
          ) values (
            '00000000-0000-4000-8000-000000000005', 'sproutos.biz',
            '00000000-0000-4000-8000-000000000003',
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001'
          ) on conflict do nothing returning id`.execute(transaction)
        expect(duplicate.rows).toEqual([])

        await downManagedDomains(migrationDb)
        await downSignInMethods(migrationDb)

        const columns = await sql<{ columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = ${schema}
            and ((table_name = 'account' and column_name = 'display_identity')
              or (table_name = 'custom_domain' and column_name = 'managed_domain_policy_id'))
        `.execute(transaction)
        expect(columns.rows).toEqual([])
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
