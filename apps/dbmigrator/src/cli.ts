import { db } from "@sproutos/db"
import { deploy } from "./deploy"

/**
 * The entry point a deployment runs, not one a person runs.
 *
 * `migrate:latest` stays the command for a developer at a terminal — it is faster, it has no lock
 * to explain, and exactly one of them is ever running. This one exists for the Job that runs before
 * a rollout, where "exactly one" is not something anybody arranged.
 *
 * A non-zero exit is the contract: the Job fails, the rollout stops, and the new pods never start
 * against a schema they expect and did not get.
 */
try {
  const result = await deploy()

  if (result.applied.length === 0) {
    console.info(
      result.waited
        ? "[migrate] another process applied everything while this one waited"
        : "[migrate] schema already current",
    )
  } else {
    console.info(`[migrate] applied ${result.applied.length}:`)
    for (const name of result.applied) console.info(`  ${name}`)
  }
} catch (cause) {
  console.error("[migrate] failed:", cause)
  process.exitCode = 1
} finally {
  await db.destroy()
}
