#!/usr/bin/env node
/**
 * Every long-running entrypoint the API ships must be started by the release.
 *
 * `apps/internal-api` builds two: `server.js` and `worker.js`. The release tarball copied both and
 * `start` launched one, so the worker was shipped to production and never run — for as long as the
 * platform has existed.
 *
 * Nothing failed. `enqueue` writes a row and returns, the API answers 201 with a job id, and the
 * dashboard polls a `project_job` that stays `queued`. So creating a project sat at "creating" with
 * four pending steps; `deploy.release` never published a Lambda; `billing.roll_up_usage` never
 * turned a metered event into a figure a customer could see; retention never swept. A queue with no
 * consumer is indistinguishable from a quiet one, which is why this is a check and not a comment.
 *
 * The property: for each entrypoint `apps/internal-api/package.json`'s build produces, the deploy
 * workflow's `start` script contains a line that runs it. Parsed out of the two files rather than
 * listed here, so adding a third entrypoint fails this until the release starts it too.
 */
import { readFileSync } from "node:fs"

const BUILD_SCRIPT = "apps/internal-api/package.json"
const WORKFLOW = ".github/workflows/deploy.yml"

/** @typedef {{ scripts?: Record<string, string> }} Manifest */

const pkg = /** @type {Manifest} */ (JSON.parse(readFileSync(BUILD_SCRIPT, "utf8")))
const build = pkg.scripts?.build ?? ""

/*
  `node build.mjs src/server.ts build/server.js` — the third token is the artefact. Read from the
  build command because that is what decides which files exist; a hardcoded list here would be a
  second place to forget the same thing.
*/
const entrypoints = [...build.matchAll(/build\/([a-z0-9-]+\.js)/g)].flatMap((match) =>
  match[1] === undefined ? [] : [match[1]],
)

if (entrypoints.length === 0) {
  console.error(`error: found no build/*.js entrypoints in ${BUILD_SCRIPT}'s build script.`)
  console.error("If the build changed shape, this check needs to change with it.")
  process.exit(1)
}

const workflow = readFileSync(WORKFLOW, "utf8")

/*
  The `start` script is written line by line inside a YAML block scalar, so the thing to match is
  the `echo 'node …'` that composes it rather than a shell file that exists anywhere.
*/
const started = new Set(
  [...workflow.matchAll(/echo 'node \/opt\/sproutos\/api\/([a-z0-9-]+\.js)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  ),
)

const missing = entrypoints.filter((entry) => !started.has(entry))

for (const entry of missing) {
  console.error(
    `error: apps/internal-api builds ${entry} and the release never starts it. ` +
      `Add \`node /opt/sproutos/api/${entry} &\` to the start script in ${WORKFLOW}.`,
  )
}

if (missing.length > 0) {
  console.error("")
  console.error("A process that is shipped and not started fails silently: the work it would have")
  console.error("done simply never happens, and nothing anywhere reports an error.")
  process.exit(1)
}

console.log(
  `ok: the release starts all ${entrypoints.length} API entrypoints (${entrypoints.join(", ")}).`,
)
