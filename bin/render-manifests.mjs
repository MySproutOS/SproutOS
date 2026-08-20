#!/usr/bin/env node
/**
 * Render `deploy/` into applicable manifests, using values from the OpenTofu outputs.
 *
 * ```
 * tofu -chdir=tofu output -json > outputs.json
 * node bin/render-manifests.mjs outputs.json > rendered.yaml
 * ```
 *
 * The substitution is trivial; the refusal is the point. An unsubstituted `ACCOUNT` is valid YAML
 * that applies cleanly and fails at image pull, in production, as a CrashLoopBackOff three steps
 * removed from its cause. `render` throws rather than emit one.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
// A  import, so this must be run through `tsx` rather than bare `node` — the alternative is
// duplicating the renderer in JavaScript, and a second copy of the refusal logic is a second copy
// that can drift out of step with the tests.
import { render } from "../lib/typescript/deploy/src/render.ts"

/** OpenTofu output name → the placeholder it fills. */
const FROM_OUTPUTS = {
  aws_account_id: "ACCOUNT",
  aws_region: "REGION",
  envelope_kms_key_arn: "KMS_KEY_ARN",
  database_credentials_secret_arn: "CONTROL_PLANE_DB_SECRET_ARN",
}

const [outputsPath] = process.argv.slice(2)
if (outputsPath === undefined) {
  console.error("usage: render-manifests.mjs <tofu-outputs.json>")
  process.exit(2)
}

/** `tofu output -json` wraps each value in `{ value, type }`. */
const outputs = JSON.parse(readFileSync(outputsPath, "utf8"))

const values = {}
for (const [output, placeholder] of Object.entries(FROM_OUTPUTS)) {
  const entry = outputs[output]
  if (entry?.value !== undefined) values[placeholder] = String(entry.value)
}

// The rest come from the environment: a tag is a build fact, not an infrastructure one, and the
// tenant hostnames belong to a data plane OpenTofu does not yet describe.
for (const name of [
  "TAG",
  "TENANT_NAMESPACE",
  "TENANT_POSTGRES_HOST",
  "TENANT_VALKEY_HOST",
  "TENANT_OPENSEARCH_HOST",
]) {
  if (process.env[name] !== undefined) values[name] = process.env[name]
}

function* manifests(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* manifests(path)
    else if (entry.name.endsWith(".yaml")) yield path
  }
}

const rendered = []
for (const path of [...manifests("deploy")].sort()) {
  try {
    rendered.push(render(readFileSync(path, "utf8"), values))
  } catch (cause) {
    // Named, and fatal. Emitting the rest would produce a file that is *mostly* applicable, which
    // is worse than none of it — somebody applies it and finds out which parts were missing by
    // watching what breaks.
    console.error(`${path}: ${cause.message}`)
    process.exit(1)
  }
}

process.stdout.write(rendered.join("---\n"))
