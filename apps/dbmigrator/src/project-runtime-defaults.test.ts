import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up } from "./migrations/2026_11_23_00_00_00_project_runtime_defaults"

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

describe.skipIf(!databaseReachable)("project runtime-default backfill", () => {
  it("prefers live configuration, upgrades Node, preserves other languages, and skips non-Lambda projects", async () => {
    const schema = `project_runtime_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)
    try {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
        await sql`
          create table project (
            id uuid primary key,
            live_deployment_id uuid,
            kind text not null default 'site',
            is_group boolean not null default false,
            updated_at timestamptz not null default now(),
            deleted_at timestamptz
          )
        `.execute(trx)
        await sql`
          create table deployment (
            id uuid primary key,
            project_id uuid not null,
            preset text not null,
            runtime text,
            handler text,
            created_at timestamptz not null,
            deleted_at timestamptz
          )
        `.execute(trx)
        await sql`
          insert into project (id, live_deployment_id, kind, is_group) values
            ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'site', false),
            ('00000000-0000-0000-0000-000000000002', null, 'site', false),
            ('00000000-0000-0000-0000-000000000003', null, 'site', false),
            ('00000000-0000-0000-0000-000000000004', null, 'site', true),
            ('00000000-0000-0000-0000-000000000005', null, 'workflow', false)
        `.execute(trx)
        await sql`
          insert into deployment (id, project_id, preset, runtime, handler, created_at) values
            ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'next', 'nodejs22.x', 'run.sh', '2026-01-01'),
            ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'function', 'python3.13', 'app.handler', '2026-02-01'),
            ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'function', 'python3.14', 'app.handler', '2026-03-01'),
            ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'static', null, null, '2026-04-01'),
            ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'hono', 'nodejs22.x', 'run.sh', '2026-05-01'),
            ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000005', 'function', 'python3.14', 'app.handler', '2026-06-01')
        `.execute(trx)

        await up(trx as unknown as Kysely<unknown>)

        const rows = await sql<{
          id: string
          preset: string | null
          runtime: string | null
          handler: string | null
        }>`
          select id, deployment_preset as preset, runtime, handler from project order by id
        `.execute(trx)
        expect(rows.rows).toEqual([
          {
            id: "00000000-0000-0000-0000-000000000001",
            preset: "next",
            runtime: "nodejs24.x",
            handler: "run.sh",
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            preset: "function",
            runtime: "python3.14",
            handler: "app.handler",
          },
          {
            id: "00000000-0000-0000-0000-000000000003",
            preset: null,
            runtime: null,
            handler: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000004",
            preset: null,
            runtime: null,
            handler: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000005",
            preset: null,
            runtime: null,
            handler: null,
          },
        ])

        const deployments = await sql<{
          id: string
          runtime: string | null
          handler: string | null
        }>`
          select id, runtime, handler from deployment order by id
        `.execute(trx)
        expect(deployments.rows[0]).toEqual({
          id: "10000000-0000-0000-0000-000000000001",
          runtime: "nodejs22.x",
          handler: "run.sh",
        })
        expect(deployments.rows[1]).toEqual({
          id: "10000000-0000-0000-0000-000000000002",
          runtime: "python3.13",
          handler: "app.handler",
        })
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
