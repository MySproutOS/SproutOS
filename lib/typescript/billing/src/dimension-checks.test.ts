import { db } from "@sproutos/db"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"

/**
 * The billable dimensions are a list in four tables, and two of them were a release behind.
 *
 * `usage_event` and `price_book_item` were widened for sandbox billing; `usage_rollup` and
 * `statement_line_item` were not. The result was not "sandboxes are not billed" — `rollUpUsage` is
 * one job over every organization's unrated events, so the first metered sandbox anywhere made it
 * throw on a check constraint and **nothing on the platform was rolled up or charged** while one
 * existed. A feature nobody had used would have stopped the billing of everybody who had.
 *
 * The sandbox migration's own comment says "Both tables get it" and names two. It was right about
 * the mechanism and wrong about the count. This reads the constraints out of `pg_constraint` rather
 * than from a list in this file, because a list here is the fifth copy of the thing that went
 * wrong.
 */
async function allowed(table: string): Promise<Set<string>> {
  const row = await sql<{ definition: string }>`
    select pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conname = ${`${table}_dimension_check`}
       and conrelid = ${table}::regclass
     limit 1
  `.execute(db)

  const definition = row.rows[0]?.definition
  if (definition === undefined) throw new Error(`${table} has no dimension check constraint`)
  return new Set([...definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]))
}

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

describe.runIf(reachable)("the dimension lists", () => {
  it("never lets a meter write something the rollup will refuse", async () => {
    /*
      The invariant is a superset, not equality, and the difference is deliberate. A rollup or a
      line item may carry a dimension no new event can be written on — `site_vcpu_second` exists in
      rows rolled up before Lambda retired it, and narrowing to match would mean deleting rows an
      invoice is reconciled from. The reverse is the bug: a dimension the meter can write and the
      rollup refuses stops the job for every customer.
    */
    const events = await allowed("usage_event")

    for (const table of ["usage_rollup", "statement_line_item"] as const) {
      const downstream = await allowed(table)
      const missing = [...events].filter((dimension) => !downstream.has(dimension))
      expect(missing, `${table} refuses dimensions the meter can write`).toEqual([])
    }
  })

  it("prices everything it meters", async () => {
    // A dimension that meters and never rates produces usage a customer can see and is never
    // charged for — the sandbox migration's own words, and the other half of the same list.
    const events = await allowed("usage_event")
    const prices = await allowed("price_book_item")
    expect([...events].filter((dimension) => !prices.has(dimension))).toEqual([])
  })

  it("has a rate for every dimension, not just permission for one", async () => {
    /*
      The constraint says what may be written; the seeded price book says what it costs. A
      dimension allowed by all four constraints and absent from the current book rates at nothing,
      which is metering to nobody with every check passing.
    */
    const book = await db
      .selectFrom("priceBookItem")
      .innerJoin("priceBook", "priceBook.id", "priceBookItem.priceBookId")
      .select(["priceBookItem.dimension as dimension"])
      .where("priceBook.effectiveAt", "<=", new Date())
      .execute()

    const priced = new Set(book.map((row) => row.dimension))
    const events = await allowed("usage_event")
    expect([...events].filter((dimension) => !priced.has(dimension))).toEqual([])
  })
})
