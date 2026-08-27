import { db } from "@sproutos/db"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

describe("the Postgres raw-usage cutover", () => {
  it("has removed the legacy raw table and left no claimable rollup jobs", async () => {
    const result = await sql<{ tableName: string | null; claimable: string }>`
      select
        to_regclass('public.usage_event')::text as "tableName",
        count(*) filter (
          where kind = 'billing.roll_up_usage'
            and state in ('queued', 'leased', 'running')
        )::text as "claimable"
      from background_job
    `.execute(db)

    expect(result.rows[0]).toEqual({ tableName: null, claimable: "0" })
  })
})
