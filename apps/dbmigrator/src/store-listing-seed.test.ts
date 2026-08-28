import { db } from "@sproutos/db"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"
import { LISTING_ARCHIVED } from "./seeds/0004_store_listing"

/**
 * The status the seed writes has to be one the table accepts.
 *
 * `withdrawn` was the natural word for a listing pulled from the catalogue, and it is not in
 * `store_listing_status_check` — the fifth time on this codebase that a value chosen for how it
 * reads has failed against a constraint that was two lines away. The check that catches it is not
 * "does this string look right" but "does the database agree", so the constraint is read.
 *
 * Read in both directions on purpose. A seed writing a value the constraint forbids fails at
 * migrate time; a constraint that quietly loses a value the seed relies on fails later and further
 * away, when a listing that should have been archived is still forkable.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

async function allowedStatuses(): Promise<string[]> {
  const row = await sql<{ def: string }>`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'store_listing'::regclass and conname = 'store_listing_status_check'
  `.execute(db)

  const definition = row.rows[0]?.def ?? ""
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1])
}

describe.runIf(reachable)("the store listing seed", () => {
  it("archives with a status the table accepts", async () => {
    expect(await allowedStatuses()).toContain(LISTING_ARCHIVED)
  })

  it("leaves no published listing without a Dockerfile path", async () => {
    // The premise of the store is that a listed application deploys. A published row whose
    // `dockerfile_path` points nowhere is a fork that dies at the build, after the customer has
    // a repository — which is exactly what two thirds of the original catalogue did.
    const bad = await db
      .selectFrom("storeListing")
      .select(["slug", "dockerfilePath", "rootDir"])
      .where("status", "=", "published")
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("dockerfilePath", "=", ""),
          eb("dockerfilePath", "like", "/%"),
          eb("rootDir", "=", ""),
        ]),
      )
      .execute()

    expect(bad).toEqual([])
  })

  it("leaves no published listing without a SproutOS-Apps instruction marker", async () => {
    const bad = await db
      .selectFrom("storeListing")
      .select("slug")
      .where("status", "=", "published")
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("deploymentSourceOwner", "!=", "SproutOS-Apps"),
          eb("deploymentInstructionsPath", "is", null),
          eb("deploymentSourceRepo", "is", null),
        ]),
      )
      .execute()

    expect(bad).toEqual([])
  })
})
