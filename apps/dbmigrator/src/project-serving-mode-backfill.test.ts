import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up } from "./migrations/2026_11_08_00_00_00_backfill_project_serving_mode"

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

describe.skipIf(!databaseReachable)("project serving-mode backfill", () => {
  it("classifies legacy live deployments without changing explicit or ambiguous projects", async () => {
    const schema = `project_serving_mode_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)
    try {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
        await sql`
          create table deployment (
            id uuid primary key,
            preset text not null,
            static_artifact_key text,
            lambda_version bigint,
            deleted_at timestamptz
          )
        `.execute(trx)
        await sql`
          create table project (
            id uuid primary key,
            live_deployment_id uuid references deployment(id),
            serving_mode text,
            is_group boolean not null default false,
            updated_at timestamptz not null,
            deleted_at timestamptz
          )
        `.execute(trx)
        await sql`
          insert into deployment (id, preset, static_artifact_key, lambda_version) values
            ('00000000-0000-0000-0000-000000000001', 'unknown', null, 7),
            ('00000000-0000-0000-0000-000000000002', 'static', 'static/two.zip', null),
            ('00000000-0000-0000-0000-000000000003', 'unknown', null, null),
            ('00000000-0000-0000-0000-000000000004', 'unknown', null, 8)
        `.execute(trx)
        await sql`
          insert into project (id, live_deployment_id, serving_mode, is_group, updated_at) values
            ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', null, false, now()),
            ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002', null, false, now()),
            ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000003', null, false, now()),
            ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000004', 'static', false, now()),
            ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000004', null, true, now())
        `.execute(trx)

        await up(trx as unknown as Kysely<unknown>)

        const rows = await sql<{ id: string; servingMode: string | null }>`
          select id, serving_mode as "servingMode" from project order by id
        `.execute(trx)
        expect(rows.rows).toEqual([
          { id: "00000000-0000-0000-0000-000000000011", servingMode: "serverless" },
          { id: "00000000-0000-0000-0000-000000000012", servingMode: "static" },
          { id: "00000000-0000-0000-0000-000000000013", servingMode: null },
          { id: "00000000-0000-0000-0000-000000000014", servingMode: "static" },
          { id: "00000000-0000-0000-0000-000000000015", servingMode: null },
        ])
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
