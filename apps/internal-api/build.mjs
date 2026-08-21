#!/usr/bin/env node
/**
 * Bundle the API into one file for the container.
 *
 * `tsc -b` alone produces ESM whose relative imports have no extensions — because the workspace's
 * `moduleResolution` is `bundler`, which means exactly what it says: a bundler is expected to
 * resolve them. Node's ESM loader does not, so the compiled output starts and immediately fails with
 * `ERR_MODULE_NOT_FOUND` on the first relative import.
 *
 * That is invisible in development, where `tsx` resolves the same specifiers happily, and invisible
 * in CI, where `tsc -b` only typechecks. It appears the first time somebody runs the image — which
 * is where I found it.
 *
 * Third-party dependencies stay external; **workspace packages do not**.
 *
 * `packages: "external"` externalises everything non-relative, which sounds right and is wrong here:
 * `@lib/dao` and its siblings are TypeScript *source*, exported as `./src/index.ts`. Left external,
 * Node resolves them at runtime and tries to parse a `.ts` file as JavaScript —
 * `SyntaxError: Export 'AgentConfigUpsert' is not defined in module`, which is what the image
 * actually did before this.
 *
 * Real npm dependencies must stay external for the opposite reason: bundling `pg`, `@aws-sdk/*` and
 * their native bindings inlines packages that resolve files at runtime relative to their own
 * directory, and they break when moved.
 *
 * So the external list is computed: every dependency whose version is not `workspace:*`.
 *
 * **Transitively**, which it was not. The list came from this app's own `dependencies`, and a
 * workspace package is bundled *in* — so `@lib/agent`'s dependency on
 * `@anthropic-ai/claude-agent-sdk` was neither declared here nor externalised, and esbuild inlined
 * it. The SDK then could not find the sibling package holding its native binary, because after
 * bundling there is no sibling and no package directory to be relative to. The failure was
 * `Native CLI binary for linux-x64 not found` inside an agent turn — a message about the wrong
 * libc, from a bundler problem, three layers from its cause.
 *
 * The rule was already written down one paragraph up: "Real npm dependencies must stay external …
 * they break when moved." It is just as true of a dependency reached through a workspace package,
 * and the first version only applied it to the direct ones.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { build } from "esbuild"

/** The workspace root, two directories up from `apps/internal-api`. */
const ROOT = resolve(process.cwd(), "..", "..")

const entry = process.argv[2] ?? "src/index.ts"
const outfile = process.argv[3] ?? "build/index.js"

/**
 * Every third-party dependency reachable from this app, following workspace packages through.
 *
 * A workspace package is bundled, so its own third-party dependencies end up in this bundle too and
 * must be externalised exactly as this app's are. Walked rather than listed, because the alternative
 * is copying every library's dependencies into every app that uses it and keeping them in step.
 *
 * @param {string} manifestPath
 * @returns {string[]}
 */
function externalDependencies(manifestPath) {
  /** @type {Set<string>} */
  const external = new Set()
  /** @type {Set<string>} */
  const visited = new Set()

  /** @param {string} path */
  function walk(path) {
    if (visited.has(path)) return
    visited.add(path)

    const manifest = /** @type {{ dependencies?: Record<string, string> }} */ (
      JSON.parse(readFileSync(path, "utf8"))
    )

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!version.startsWith("workspace:")) {
        external.add(name)
        continue
      }
      /*
        Followed through pnpm's symlink, not `require.resolve`.

        `require.resolve("@lib/agent/package.json")` throws: these packages publish an `exports` map
        that lists `.` and `./*` and not `./package.json`, and Node honours that — a manifest is not
        an export unless it says so. Reading the file through the symlink sidesteps the map entirely
        and is what pnpm's layout guarantees is there.

        The path cannot be guessed from the name either. `@ui/base` lives at
        `lib/typescript/ui/base` and `@utils/crypto` at `lib/typescript/utils/crypto`; a guess that
        missed would silently skip that package's dependencies, which is exactly the bug this
        function exists to fix.
      */
      const nested = join(dirname(path), "node_modules", name, "package.json")
      if (existsSync(nested)) {
        walk(nested)
        continue
      }
      // Hoisted to the workspace root instead, which is where pnpm puts a package that nothing
      // else shadows.
      const hoisted = join(ROOT, "node_modules", name, "package.json")
      if (existsSync(hoisted)) walk(hoisted)
    }
  }

  walk(manifestPath)
  return [...external]
}

const external = externalDependencies("package.json")

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  /*
    ESM output has no `require`, and esbuild replaces it with a stub that throws
    `Dynamic require of "node:https" is not supported`.

    That is not hypothetical: something in the bundled workspace graph calls it, and the image failed
    on exactly this line. The banner restores a real `require` built from the module's own URL, which
    is the supported way to run a CJS-touching dependency from an ESM bundle.
  */
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirname_of } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_of(__filename);",
    ].join("\n"),
  },
  sourcemap: true,
  // A stack trace from a bundle points at the bundle. The sourcemap is what makes a production
  // error name the file somebody can open.
  logLevel: "info",
})
