import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up } from "./migrations/2026_10_31_00_00_00_acme_certificate_lifecycle"

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

describe.skipIf(!databaseReachable)("ACME certificate lifecycle migration", () => {
  it("retains serving versions but makes provenance-less material immediately due", async () => {
    const schema = `acme_lifecycle_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)
    try {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
        await sql`
          create table custom_domain (
            id uuid primary key,
            status text not null,
            certificate_object_key text,
            certificate_object_version text,
            next_retry_at timestamptz,
            updated_at timestamptz not null,
            deleted_at timestamptz
          )
        `.execute(trx)
        await sql`
          create table platform_edge_certificate (
            id text primary key,
            certificate_object_version text,
            next_retry_at timestamptz not null,
            updated_at timestamptz not null
          )
        `.execute(trx)
        const future = new Date("2099-01-01T00:00:00Z")
        await sql`
          insert into custom_domain
            (id, status, certificate_object_key, certificate_object_version, next_retry_at, updated_at)
          values
            (
              '00000000-0000-0000-0000-000000000001',
              'active',
              'custom-domains/legacy/2099.json',
              'custom-v1',
              ${future},
              ${future}
            )
        `.execute(trx)
        await sql`
          insert into platform_edge_certificate
            (id, certificate_object_version, next_retry_at, updated_at)
          values ('platform', 'platform-v1', ${future}, ${future})
        `.execute(trx)

        await up(trx as unknown as Kysely<unknown>)
        const custom = await sql<{
          certificateDirectoryUrl: string | null
          deployedKey: string | null
          deployedVersion: string | null
          nextRetryAt: Date
        }>`
          select
            certificate_directory_url as "certificateDirectoryUrl",
            deployed_certificate_object_key as "deployedKey",
            deployed_certificate_object_version as "deployedVersion",
            next_retry_at as "nextRetryAt"
          from custom_domain
        `.execute(trx)
        const platform = await sql<{ certificateDirectoryUrl: string | null; nextRetryAt: Date }>`
          select
            certificate_directory_url as "certificateDirectoryUrl",
            next_retry_at as "nextRetryAt"
          from platform_edge_certificate
        `.execute(trx)

        expect(custom.rows[0]).toMatchObject({
          certificateDirectoryUrl: null,
          deployedKey: "custom-domains/legacy/2099.json",
          deployedVersion: "custom-v1",
        })
        expect(Date.now() - custom.rows[0].nextRetryAt.getTime()).toBeLessThan(10_000)
        expect(custom.rows[0].nextRetryAt.getTime()).toBeLessThan(future.getTime())
        expect(platform.rows[0].certificateDirectoryUrl).toBeNull()
        expect(platform.rows[0].nextRetryAt.getTime()).toBeLessThan(future.getTime())

        const constraints = await sql<{ name: string }>`
          select conname as name
            from pg_constraint
           where connamespace = ${schema}::regnamespace
             and conname in (
               'custom_domain_certificate_provenance_pair_check',
               'custom_domain_deployed_object_pair_check',
               'platform_edge_certificate_provenance_pair_check'
             )
           order by conname
        `.execute(trx)
        expect(constraints.rows.map(({ name }) => name)).toEqual([
          "custom_domain_certificate_provenance_pair_check",
          "custom_domain_deployed_object_pair_check",
          "platform_edge_certificate_provenance_pair_check",
        ])
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
