#!/usr/bin/env node
/**
 * Every environment variable the deployed control plane reads must have somewhere to come from.
 *
 * Three lists decide what reaches a production instance, and they were maintained separately:
 *
 * - `bin/put-app-secrets.sh` — which keys are copied out of a local `.env` into Parameter Store.
 * - `tofu/user-data.sh.tftpl` `write_app_secrets` — which of those the instance writes to its env.
 * - `tofu/user-data.sh.tftpl` heredoc — the non-secret configuration written directly.
 *
 * Nothing compared them to what the code actually reads, and nothing compared them to each other.
 * The result was not a broken deploy. A key named in `write_app_secrets` but absent from Parameter
 * Store is silently skipped — the loop iterates over what SSM *returned* — so the instance boots
 * clean, reports healthy, and answers 500 on the first request that needs the value. `APK_SIGNER_TOKEN`
 * and `KAFKA_BROKERS` were in that state, and the whole tenant data plane, tenant deploys, metering,
 * observability and the agent's API key were never on any list at all.
 *
 * `docs/findings/0001` is checks that cannot fail; `0007` and `0012` are the last mile. This is
 * both: configuration that OpenTofu created, that the application requires, and that no step
 * carried from one to the other.
 *
 * The check is deliberately about *reachability*, not values. It cannot know whether
 * `SERVICE_VALKEY_PUBLIC_HOST` points at a live Valkey; it can know that nothing would ever set it.
 *
 * ## The direction that was missing
 *
 * The three lists above were compared **to each other and to nothing else**, while the sentence at
 * the top of this file claims the check is about what the code reads. It never read the code. So a
 * variable the application reads and no list provides was invisible — which is exactly what
 * happened to `SERVICE_BUILD_BUCKET`: `deploy.ts` signs an upload URL for
 * `process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts"`, nothing set it in production, and
 * every customer deploy failed on a presigned PUT to a bucket that exists in no account. The
 * assets bucket one line above it had already been fixed for the identical reason.
 *
 * A fallback is what makes this silent. Without one the application would crash at boot; with one it
 * runs, looks healthy, and is wrong somewhere only a real request reaches.
 *
 * ## And the syntax it first missed
 *
 * The first version matched `process.env.NAME` and nothing else. `daytonaConfigFromEnv` takes
 * `env: NodeJS.ProcessEnv = process.env` and reads `env.DAYTONA_API_KEY` — done that way
 * precisely so it can be tested — so the check reported the configuration clean while the key that
 * decides whether a sandbox can exist at all was provided by nothing, anywhere. A check that knows
 * one spelling is a check that is confident about the code it happens to recognise.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const putSecrets = readFileSync("bin/put-app-secrets.sh", "utf8")
const userData = readFileSync("tofu/user-data.sh.tftpl", "utf8")
const ecs = readFileSync("tofu/ecs.tf", "utf8")
const templateEnv = readFileSync(".template.env", "utf8")
const routerLogs = readFileSync("services/router/src/logs.rs", "utf8")
const lambdaPublish = readFileSync("lib/typescript/lambda/src/publish.ts", "utf8")

/*
  Upload URLs are minted by the API process, while builds are consumed later by the worker.
  Merely finding a variable somewhere in the shared task definition is therefore insufficient:
  SERVICE_BUILD_BUCKET existed on the worker while the API used its development fallback, and a
  real CLI deploy received a validly signed PUT URL for a bucket that did not exist.
*/
const apiContainer = /\n\s*name\s*=\s*"api"([\s\S]*?)\n\s*name\s*=\s*"worker"/.exec(ecs)?.[1]
if (apiContainer === undefined) {
  throw new Error("tofu/ecs.tf no longer has an API container followed by the worker container")
}
if (!/name\s*=\s*"SERVICE_BUILD_BUCKET"/.test(apiContainer)) {
  throw new Error(
    "the API container must receive SERVICE_BUILD_BUCKET because deploy.ts signs primary build uploads",
  )
}

/**
 * Names that look like an environment variable, out of arbitrary text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function envNames(text) {
  return text.split(/[^A-Z0-9_]+/).filter((token) => /^[A-Z][A-Z0-9_]*$/.test(token))
}

/**
 * The allowlist `put-app-secrets.sh` copies into Parameter Store.
 *
 * @returns {Set<string>}
 */
function parameterStoreKeys() {
  const block = /KEYS=\(([\s\S]*?)\n\)/.exec(putSecrets)
  if (block === null || block[1] === undefined) {
    throw new Error("bin/put-app-secrets.sh no longer declares KEYS=( ... )")
  }
  /*
    Comments stripped before the names are read.

    `envNames` keeps any run of capitals, and the first letter of an English sentence is a run of
    capitals of length one — so every `# Runtime logs…`, `# Only the password…`, `# Unset, the
    ingest route…` contributed a one-letter key, and the word "URL" in prose contributed `URL`.
    Nine invented names appeared under "Stored and never read", which is how a real one stops being
    read: a report that is mostly noise is a report nobody finishes.
  */
  const declarations = block[1].replaceAll(/#[^\n]*/g, "")
  return new Set(envNames(declarations))
}

/**
 * Every key any `write_app_secrets "..."` call asks the instance to write.
 *
 * @returns {Set<string>}
 */
function requestedAtBoot() {
  /** @type {Set<string>} */
  const keys = new Set()
  for (const match of userData.matchAll(/write_app_secrets\s+"([^"]*)"/g)) {
    const list = match[1]
    if (list === undefined) continue
    for (const key of envNames(list)) keys.add(key)
  }
  if (keys.size === 0) throw new Error("tofu/user-data.sh.tftpl no longer calls write_app_secrets")
  return keys
}

/** Parameter names injected directly into ECS task definitions. */
function requestedByEcs() {
  /** @type {Set<string>} */
  const keys = new Set()
  for (const match of ecs.matchAll(
    /ecs_(?:website|api|worker)_parameter_names\s*=\s*\[([\s\S]*?)\n\s*\]/g,
  )) {
    const list = match[1]
    if (list === undefined) continue
    for (const key of envNames(list.replaceAll(/#[^\n]*/g, ""))) keys.add(key)
  }
  if (keys.size === 0) throw new Error("tofu/ecs.tf no longer declares ECS parameter allowlists")
  return keys
}

/**
 * Non-secret configuration written straight into the env file.
 *
 * @returns {Set<string>}
 */
function writtenDirectly() {
  /** @type {Set<string>} */
  const keys = new Set()
  for (const match of userData.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  for (const match of userData.matchAll(/echo\s+"([A-Z][A-Z0-9_]*)=/g)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * Every `process.env.NAME` the deployed TypeScript actually reads.
 *
 * `git grep` rather than a directory walk, so nothing in `node_modules` or a build output counts —
 * a bundled dependency's own environment variables are not this platform's configuration, and
 * including them buries the real names.
 *
 * @returns {Set<string>}
 */
function readByCode() {
  /*
    Two spellings, because the code uses two.

    `process.env.NAME` is the common one. `env.NAME` appears wherever a module takes
    `env: NodeJS.ProcessEnv = process.env` so it can be tested — which is good practice and was
    invisible here. Matching the second everywhere would catch any local named `env`; matching it
    only in files that mention `NodeJS.ProcessEnv` keeps it to the modules that actually read
    configuration.
  */
  const out = execFileSync(
    "git",
    [
      "grep",
      "-hoE",
      String.raw`process\.env\.[A-Z][A-Z0-9_]*`,
      "--",
      "apps",
      "lib",
      "packages",
      // Tests invent names (`GREETING`, `SOME_UNRELATED_THING`) to exercise the readers. They are
      // not configuration, and left in they are most of the output — which is how a report stops
      // being read.
      ":!*.test.ts",
      ":!*.test.tsx",
      ":!*.test.mts",
    ],
    { encoding: "utf8" },
  )
  /** @type {Set<string>} */
  const keys = new Set()

  const viaParameter = execFileSync(
    "sh",
    [
      "-c",
      // Files that declare a ProcessEnv parameter, then the `env.NAME` reads inside them.
      String.raw`git grep -l 'NodeJS\.ProcessEnv' -- apps lib packages ':!*.test.ts' ':!*.test.tsx' ` +
        String.raw`| xargs -r grep -hoE '\benv\.[A-Z][A-Z0-9_]*' || true`,
    ],
    { encoding: "utf8" },
  )

  for (const line of `${out}\n${viaParameter}`.split("\n")) {
    const name = line
      .trim()
      .replace("process.env.", "")
      .replace(/^env\./, "")
    // `process.env[`NEXT_PUBLIC_${x}`]` matches as far as the interpolation, leaving a prefix that
    // is not a variable name.
    if (name !== "" && !name.endsWith("_")) keys.add(name)
  }
  return keys
}

/**
 * Names that come from somewhere other than this platform's configuration.
 *
 * The runtime sets some (`NODE_ENV`, `AWS_REGION`, the Lambda and GitHub Actions variables);
 * developers set others locally and production deliberately leaves them unset, which is a
 * meaningful state rather than a gap. Listed explicitly, because the whole value of this direction
 * is that an unrecognised name is reported — a wildcard would quietly absorb the next real one.
 */
const NOT_OUR_CONFIGURATION = new Set([
  "NODE_ENV",
  "PORT",
  "HOSTNAME",
  "HOME",
  "PATH",
  "CI",
  "TZ",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_EXEC_WRAPPER",
  "AWS_LWA_PORT",
  "GITHUB_ACTIONS",
  "GITHUB_OUTPUT",
  "GITHUB_TOKEN",
  "VITEST",
])

const inParameterStore = parameterStoreKeys()
const requested = requestedAtBoot()
const requestedEcs = requestedByEcs()
const direct = writtenDirectly()

/*
  Two directions, two severities.

  A key requested at boot that nothing provides is a 500 in production the first time somebody
  touches the feature — that fails the build. A parameter stored and never read is a credential
  sitting in an account for no reason: worth saying every run, not worth blocking a deploy over,
  because the fix is sometimes to delete it and sometimes to wire it up and only a person knows
  which. `OVH_CLICKHOUSE_PASSWORD` is the standing example — stored, never delivered, and the
  application reads `CLICKHOUSE_PASSWORD` anyway, so wiring it needs a decision about the name.
*/
const problems = []
const warnings = []

/*
  The log endpoint is a route on the router, not an internal-API route and not configuration.

  Production once held `https://api.sproutos.me/v1/internal/logs` in Parameter Store while the
  router accepted only `POST /_sproutos/logs`. Both configurations looked complete to every list
  check above; the extension simply received 404 and dropped every batch. A generated tenant
  hostname is already guaranteed to reach the router, so publish derives the endpoint from that
  hostname. Compare its path constant to Rust so changing either half cannot strand the other.
*/
const ingestPathMatch = /pub const INGEST_PATH: &str = "([^"]+)";/.exec(routerLogs)
if (ingestPathMatch?.[1] === undefined) {
  throw new Error("services/router/src/logs.rs no longer declares INGEST_PATH as a string constant")
}
const ingestPath = ingestPathMatch[1]
const publishedPath = /export const LOG_INGEST_PATH = "([^"]+)"/.exec(lambdaPublish)?.[1]
if (publishedPath !== ingestPath) {
  problems.push(
    `lib/typescript/lambda/src/publish.ts uses ${publishedPath ?? "no LOG_INGEST_PATH"}, but ` +
      `services/router::logs::INGEST_PATH is ${ingestPath}. Every extension batch would miss.`,
  )
}
if (
  inParameterStore.has("SPROUTOS_LOG_ENDPOINT") ||
  requested.has("SPROUTOS_LOG_ENDPOINT") ||
  direct.has("SPROUTOS_LOG_ENDPOINT") ||
  /^SPROUTOS_LOG_ENDPOINT=/m.test(templateEnv)
) {
  problems.push(
    "SPROUTOS_LOG_ENDPOINT must be derived from each deployment's generated tenant hostname, not " +
      "read from global configuration where a stale host can route every batch to another service.",
  )
}

/*
  The silent one. `write_app_secrets` filters what SSM returned by this list, so a name that is not
  a parameter is not an error — it is an absence, and absence is indistinguishable from a value
  nobody happened to need on this boot.
*/
for (const key of [...requested].sort((a, b) => a.localeCompare(b))) {
  if (!inParameterStore.has(key)) {
    problems.push(
      `${key} is requested by write_app_secrets but is not in put-app-secrets.sh's allowlist, ` +
        `so nothing ever writes it to Parameter Store. The instance will boot without it.`,
    )
  }
}

/*
  The other direction is a weaker signal but still worth saying: a parameter that is stored and
  never read is a credential sitting in an account for no reason.
*/
for (const key of [...inParameterStore].sort((a, b) => a.localeCompare(b))) {
  if (!requested.has(key) && !requestedEcs.has(key) && !direct.has(key)) {
    warnings.push(
      `${key} is written to Parameter Store by put-app-secrets.sh but no write_app_secrets call ` +
        `asks for it, so no instance ever reads it.`,
    )
  }
}

/*
  The third direction: read by the application, provided by nothing.

  A warning rather than a failure, because "provided by nothing" is not always wrong — a feature can
  be deliberately off in production, and `webAdapterLayerArn`'s override is an example of a name
  that should stay unset. What it must not be is *unnoticed*, which is what it was.
*/
const read = readByCode()
for (const key of [...read].sort((a, b) => a.localeCompare(b))) {
  if (NOT_OUR_CONFIGURATION.has(key)) continue
  if (requested.has(key) || direct.has(key) || inParameterStore.has(key)) continue
  warnings.push(
    `${key} is read by the application and no list provides it. If the code has a fallback, ` +
      `production is silently running on the fallback.`,
  )
}

/*
  The list check above cannot see an empty value.

  `put-app-secrets.sh` skips a key whose value is blank in the local `.env` — `if value:` — so a key
  can be on every list and still never become a parameter. That is exactly how APK_SIGNER_TOKEN and
  KAFKA_BROKERS came to be requested at boot and absent in production, with all three lists in
  agreement. Only asking Parameter Store what is actually there can tell.

  Opt-in, because it needs credentials. Run with `--live` where they exist — the deploy workflow has
  them, and that is before any instance boots with the gap.
*/
if (process.argv.includes("--live")) {
  const { execFileSync } = await import("node:child_process")
  const path = process.env.APPLICATION_PARAMETER_PATH ?? "/sproutos/application"

  const raw = execFileSync(
    "aws",
    [
      "ssm",
      "get-parameters-by-path",
      "--path",
      path,
      "--recursive",
      "--query",
      "Parameters[].Name",
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  )

  // Names only — the values are secrets and this prints its findings.
  const names = /** @type {string[]} */ (JSON.parse(String(raw)))
  /** @type {Set<string>} */
  const present = new Set()
  for (const name of names) {
    const leaf = name.split("/").pop()
    if (leaf !== undefined) present.add(leaf)
  }

  for (const key of [...requested].sort((a, b) => a.localeCompare(b))) {
    if (!present.has(key)) {
      problems.push(
        `${key} is requested at boot and is not in Parameter Store at ${path}. ` +
          `It is most likely empty in the .env that put-app-secrets.sh was run against, ` +
          `which that script skips silently.`,
      )
    }
  }
}

/*
  The fourth list, which is the one that actually reaches a machine.

  Everything above compares the repository against itself and against Parameter Store. None of it
  can see the gap that has now caused two separate outages: `tofu/user-data.sh.tftpl` is rendered
  into a **launch template**, and the Deploy workflow does not run `tofu apply`. So a change to what
  an instance reads is real in git, real in Parameter Store, and absent from every instance until
  somebody remembers the apply.

  It has failed both ways. Once loudly and then invisibly — `CreateLaunchTemplateVersion` refused a
  boot script over 16384 bytes, so no new version was created and instances kept booting the last
  one that fit, while `plan` reported the drift as an ordinary pending change. Once quietly —
  `NEON_ORG_ID` was added to every list here, this check passed, and the live instance did not have
  it, so Postgres kept answering the same error.

  So this reads the deployed template and asks whether the names the repository expects are in it.
  Not the values: those are secrets and this prints its findings. Gzipped since the script outgrew
  the 16 KB limit, which `Buffer`/`gunzipSync` handle without the value ever being logged.
*/
if (process.argv.includes("--live")) {
  const { execFileSync } = await import("node:child_process")
  const { gunzipSync } = await import("node:zlib")

  const expected = new Set([...requested, ...direct])

  for (const service of ["website", "router"]) {
    let deployed
    try {
      /*
        Found by prefix, not by name.

        OpenTofu creates these with `name_prefix`, so the real names carry a generated suffix —
        `sproutos-website-2026082501450195980000000f`. Asking for `sproutos-website` returns
        `InvalidLaunchTemplateName.NotFoundException`, which this used to do: the check reported
        that it could not read the template and passed. Caught only by deliberately breaking it,
        which is the whole reason to.
      */
      const listed = execFileSync(
        "aws",
        [
          "ec2",
          "describe-launch-templates",
          "--query",
          `LaunchTemplates[?starts_with(LaunchTemplateName, '${process.env.NAME_PREFIX ?? "sproutos"}-${service}-')].LaunchTemplateId | [0]`,
          "--output",
          "text",
        ],
        { encoding: "utf8" },
      ).trim()

      if (listed === "" || listed === "None") throw new Error(`no launch template for ${service}`)

      const encoded = execFileSync(
        "aws",
        [
          "ec2",
          "describe-launch-template-versions",
          "--launch-template-id",
          listed,
          "--versions",
          "$Latest",
          "--query",
          "LaunchTemplateVersions[0].LaunchTemplateData.UserData",
          "--output",
          "text",
        ],
        { encoding: "utf8" },
      ).trim()

      const bytes = Buffer.from(encoded, "base64")
      // Gzipped since the script passed 16 KB; tolerate either form rather than assuming.
      deployed =
        bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString() : bytes.toString()
    } catch {
      warnings.push(
        `could not read the ${service} launch template, so nothing here checked what its instances ` +
          `actually boot with.`,
      )
      continue
    }

    for (const key of [...expected].sort((a, b) => a.localeCompare(b))) {
      // The name has to appear somewhere in the rendered script — in a `write_app_secrets` list or
      // as an assignment. Absent means the template predates the change that added it.
      if (!deployed.includes(key)) {
        problems.push(
          `${key} is expected by the repository but is not in the deployed ${service} launch ` +
            `template. Run \`tofu apply\` — the Deploy workflow does not, so instances will keep ` +
            `booting without it.`,
        )
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn("Stored and never read:\n")
  for (const warning of warnings) console.warn(`  - ${warning}`)
  console.warn("")
}

if (problems.length > 0) {
  console.error("Application configuration cannot reach production:\n")
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    "\nA missing key does not fail a boot. The site comes up, reports healthy, and answers 500 on\n" +
      "the first request that needs the value — which is how GITHUB_OAUTH_CLIENT_ID was found.\n",
  )
  process.exit(1)
}

console.log(
  `Application configuration is reachable: ${inParameterStore.size} parameters, ` +
    `${requested.size} requested at boot, ${direct.size} written directly.`,
)
