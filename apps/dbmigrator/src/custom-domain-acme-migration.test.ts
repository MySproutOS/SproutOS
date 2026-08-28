import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up as createCustomDomain } from "./migrations/2026_09_29_00_00_00_custom_domain"
import { up as migrateCustomDomainToAcme } from "./migrations/2026_10_22_00_00_00_custom_domain_acme"

const up = await (async () => {
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

describe.skipIf(!up)("custom-domain ACME migration", () => {
  it("preserves launch-era claims and queues live rows for reissuance", async () => {
    const schema = `custom_domain_acme_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)

    try {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
        await sql`create table organization (id uuid primary key)`.execute(trx)
        await sql`create table project (
          id uuid primary key,
          organization_id uuid not null references organization(id)
        )`.execute(trx)
        await sql`insert into organization (id) values ('00000000-0000-0000-0000-000000000001')`.execute(
          trx,
        )
        await sql`insert into project (id, organization_id) values (
          '00000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-000000000001'
        )`.execute(trx)

        const migrationDb = trx as unknown as Kysely<unknown>
        await createCustomDomain(migrationDb)
        await sql`insert into custom_domain (
          id, organization_id, project_id, hostname, verification_token, status, acm_certificate_arn
        ) values (
          '00000000-0000-0000-0000-000000000003',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'live.example.com', 'live-token', 'active', 'arn:aws:acm:example'
        ), (
          '00000000-0000-0000-0000-000000000004',
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
          'deleted.example.com', 'deleted-token', 'pending', null
        )`.execute(trx)
        await sql`update custom_domain set deleted_at = now() where hostname = 'deleted.example.com'`.execute(
          trx,
        )

        await migrateCustomDomainToAcme(migrationDb)

        const rows = await sql<{
          hostname: string
          status: string
          nextRetryAt: Date | null
          acmColumnPresent: boolean
        }>`
          select
            hostname,
            status,
            next_retry_at as "nextRetryAt",
            exists (
              select 1 from information_schema.columns
              where table_schema = ${schema}
                and table_name = 'custom_domain'
                and column_name = 'acm_certificate_arn'
            ) as "acmColumnPresent"
          from custom_domain
          order by hostname
        `.execute(trx)

        expect(rows.rows.map(({ nextRetryAt: _nextRetryAt, ...row }) => row)).toEqual([
          {
            hostname: "deleted.example.com",
            status: "deleting",
            acmColumnPresent: false,
          },
          {
            hostname: "live.example.com",
            status: "pending_dns",
            acmColumnPresent: false,
          },
        ])
        expect(rows.rows[0]?.nextRetryAt).toBeNull()
        expect(rows.rows[1]?.nextRetryAt).toBeInstanceOf(Date)
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
