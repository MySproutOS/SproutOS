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
 */
import { readFileSync } from "node:fs"

import { build } from "esbuild"

const entry = process.argv[2] ?? "src/index.ts"
const outfile = process.argv[3] ?? "build/index.js"

const manifest = /** @type {{ dependencies?: Record<string, string> }} */ (
  JSON.parse(readFileSync("package.json", "utf8"))
)
const external = Object.entries(manifest.dependencies ?? {})
  .filter(([, version]) => !version.startsWith("workspace:"))
  .map(([name]) => name)

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
