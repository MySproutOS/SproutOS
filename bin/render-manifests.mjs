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

/**
 * `tofu output -json` wraps each value in `{ value, type }`.
 *
 * Cast rather than left as `any`: reading `.value` off an untyped parse is how a renamed output
 * becomes a silently missing placeholder instead of an error.
 *
 * @type {Record<string, { value?: unknown } | undefined>}
 */
const outputs = /** @type {Record<string, { value?: unknown } | undefined>} */ (
  JSON.parse(readFileSync(outputsPath, "utf8"))
)

/** @type {Record<string, string>} */
const values = {}
for (const [output, placeholder] of Object.entries(FROM_OUTPUTS)) {
  const entry = outputs[output]
  // Only scalars. An output that is a list or an object is a configuration mistake, and
  // `String()` on one produces `[object Object]` — valid YAML, wrong, and silent.
  const value = entry?.value
  if (typeof value === "string" || typeof value === "number") {
    values[placeholder] = String(value)
  }
}

// The rest come from the environment: a tag is a build fact, not an infrastructure one, and the
// tenant hostnames belong to a data plane OpenTofu does not yet describe.
for (const name of [
  "TAG",
  "TENANT_NAMESPACE",
  "TENANT_POSTGRES_HOST",
  "TENANT_VALKEY_HOST",
  "TENANT_OPENSEARCH_HOST",
  "BUILD_REGISTRY_CIDR",
  "IMAGE_REGISTRY",
  // The public hostnames. From the environment rather than the OpenTofu outputs because a cluster
  // may be brought up before its DNS exists, and because the same cluster is rendered for a staging
  // host and a production one from the same state.
  "CONTROL_PLANE_HOST",
  "API_HOST",
  "SESSION_COOKIE_DOMAIN",
  "TENANT_DOMAIN",
]) {
  if (process.env[name] !== undefined) values[name] = process.env[name]
}

/**
 * Every `.yaml` under a directory, recursively.
 *
 * An array rather than a generator: a generator's yield type does not survive JSDoc inference here,
 * and the whole file then reads as `any` to the type-aware lint — which is the same class of
 * silently-unchecked that this script exists to prevent.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function manifests(directory) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...manifests(path))
    else if (entry.name.endsWith(".yaml")) found.push(path)
  }
  return found
}

const rendered = []
/*
  Sorted with an explicit comparator, and sorted at all so the output is byte-identical between
  runs: a rendered file that reorders itself makes every diff useless for spotting what changed.
*/
const paths = manifests("deploy").sort((a, b) => a.localeCompare(b))

for (const path of paths) {
  try {
    rendered.push(render(readFileSync(path, "utf8"), values))
  } catch (cause) {
    // Named, and fatal. Emitting the rest would produce a file that is *mostly* applicable, which
    // is worse than none of it — somebody applies it and finds out which parts were missing by
    // watching what breaks.
    console.error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  }
}

process.stdout.write(rendered.join("---\n"))
