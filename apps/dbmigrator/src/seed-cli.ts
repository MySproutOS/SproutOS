import path from "node:path"
import { fileURLToPath } from "node:url"
import { promises as fs } from "node:fs"
import { db } from "@sproutos/db"
import { sql } from "kysely"

/**
 * The seeds a deployment runs, which is not the same thing as the seeds a developer runs.
 *
 * `kysely seed:run` is the command at a terminal. It needs `kysely-ctl` and `tsx`, neither of which
 * belongs in a production release, and it does not coordinate — kysely-ctl does not track which
 * seeds have run, so two of these starting at once would both insert.
 *
 * ## Why seeds are deployed at all
 *
 * Because one of them is load-bearing. `/v1/orgs/:slug/billing/usage` answers **409 "No active
 * price book; usage cannot be rated"** without `0001_price_book`, which is what the dashboard's
 * balance widget was stuck on. That refusal is correct behaviour and much better than the
 * alternative: rating every tenant's usage against an empty price book produces a bill of zero and
 * looks like it worked.
 *
 * ## Idempotence is the seeds' own job
 *
 * Every seed ends in `onConflict(...).doNothing()`, so running them on each deploy converges rather
 * than duplicating. `0005_dev_fixture` returns early when `NODE_ENV` is `production` — it creates a
 * dev user and project, and this runner sets that variable rather than trusting the environment to
 * have it.
 */

/**
 * A different lock key from the migrator's.
 *
 * Sharing one would make a seed run wait behind a migration it does not depend on, and — worse —
 * make the pair look atomic when they are two separate operations that can each fail alone.
 */
const LOCK_KEY = 8_012_027n
const LOCK_TIMEOUT = "5min"

export type SeedResult = {
  ran: string[]
}

export async function runSeeds(): Promise<SeedResult> {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "seeds")

  // Sorted by filename, because the numeric prefixes are the dependency order: system roles
  // reference organizations, store listings reference categories.
  const files = (await fs.readdir(folder))
    .filter((name) => name.endsWith(".js") || name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".d.ts"))
    .toSorted()

  return await db.connection().execute(async (pinned) => {
    await sql`set lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(pinned)
    await sql`select pg_advisory_lock(${sql.lit(LOCK_KEY.toString())}::bigint)`.execute(pinned)

    try {
      const ran: string[] = []
      for (const file of files) {
        // Not named `module`: that identifier is reserved in a CommonJS scope and oxlint rejects
        // assigning to it.
        const loaded = (await import(path.join(folder, file))) as {
          seed?: (database: typeof db) => Promise<void>
        }
        if (typeof loaded.seed !== "function") continue
        // Sequential on purpose. The numeric prefixes are a dependency order — system roles
        // reference organizations, listings reference categories — so `Promise.all` here would run
        // them in whatever order they resolved and violate the ordering the names encode.
        // eslint-disable-next-line no-await-in-loop
        await loaded.seed(db)
        ran.push(file)
      }
      return { ran }
    } finally {
      await sql`select pg_advisory_unlock(${sql.lit(LOCK_KEY.toString())}::bigint)`.execute(pinned)
    }
  })
}
