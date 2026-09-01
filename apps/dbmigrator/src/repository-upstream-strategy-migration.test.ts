import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { up } from "./migrations/2026_11_13_00_00_00_repository_upstream_strategy"

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

describe.skipIf(!databaseReachable)("repository upstream-strategy migration", () => {
  it("backfills reconciliation strategies and retires the one- and two-day cadences", async () => {
    const schema = `upstream_strategy_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)
    try {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(trx)
        await sql`
          create table repository (
            id text primary key,
            upstream_full_name text,
            is_fork boolean not null default false,
            provenance text not null
          )
        `.execute(trx)
        await sql`
          create table project (
            id text primary key,
            auto_update_cadence text not null default 'one_day',
            constraint project_auto_update_cadence_check check (
              auto_update_cadence in (
                'one_day', 'two_days', 'one_week', 'one_month', 'three_months',
                'six_months', 'nine_months', 'one_year', 'two_years'
              )
            )
          )
        `.execute(trx)
        await sql`
          insert into repository (id, upstream_full_name, is_fork, provenance) values
            ('new', null, false, 'new'),
            ('fork', 'source/fork', true, 'imported'),
            ('copy', 'source/copy', false, 'template'),
            ('manual', 'source/manual', false, 'imported')
        `.execute(trx)
        await sql`
          insert into project (id, auto_update_cadence) values
            ('daily', 'one_day'),
            ('two-day', 'two_days'),
            ('nine-month', 'nine_months')
        `.execute(trx)

        await up(trx as unknown as Kysely<unknown>)

        const repositories = await sql<{ id: string; strategy: string | null }>`
          select id, upstream_strategy as strategy from repository order by id
        `.execute(trx)
        expect(repositories.rows).toEqual([
          { id: "copy", strategy: "snapshot_copy" },
          { id: "fork", strategy: "github_fork" },
          { id: "manual", strategy: "manual" },
          { id: "new", strategy: null },
        ])
        const projects = await sql<{ id: string; cadence: string }>`
          select id, auto_update_cadence as cadence from project order by id
        `.execute(trx)
        expect(projects.rows).toEqual([
          { id: "daily", cadence: "one_week" },
          { id: "nine-month", cadence: "nine_months" },
          { id: "two-day", cadence: "one_week" },
        ])

        await sql`
          do $$
          begin
            begin
              insert into project (id, auto_update_cadence) values ('retired', 'one_day');
              raise exception 'retired cadence was accepted';
            exception when check_violation then
              null;
            end;
          end
          $$
        `.execute(trx)
        await sql`
          do $$
          begin
            begin
              insert into repository (id, upstream_full_name, provenance)
              values ('unclassified', 'source/unclassified', 'imported');
              raise exception 'unclassified upstream was accepted';
            exception when check_violation then
              null;
            end;
          end
          $$
        `.execute(trx)
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
