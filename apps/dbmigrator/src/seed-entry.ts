import { db } from "@sproutos/db"
import { runSeeds } from "./seed-cli"

/*
  Set before the seeds are imported, not left to the environment.

  `0005_dev_fixture` decides whether to insert a dev user by reading `NODE_ENV`, and a release that
  happened not to set it would quietly create `dev@sproutos.dev` — an admin account — in production.
  A guard that depends on a variable nobody sets is not a guard.
*/
process.env.NODE_ENV ??= "production"

try {
  const { ran } = await runSeeds()
  console.info(`[seed] ran ${ran.length}:`)
  for (const name of ran) console.info(`  ${name}`)
} catch (cause) {
  console.error("[seed] failed:", cause)
  process.exitCode = 1
} finally {
  await db.destroy()
}
