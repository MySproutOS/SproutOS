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
 */
import { readFileSync } from "node:fs"

const putSecrets = readFileSync("bin/put-app-secrets.sh", "utf8")
const userData = readFileSync("tofu/user-data.sh.tftpl", "utf8")

/** The allowlist `put-app-secrets.sh` copies into Parameter Store. */
function parameterStoreKeys() {
  const block = /KEYS=\(([\s\S]*?)\n\)/.exec(putSecrets)
  if (block === null) throw new Error("bin/put-app-secrets.sh no longer declares KEYS=( ... )")
  return new Set(
    block[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line)),
  )
}

/** Every key any `write_app_secrets "..."` call asks the instance to write. */
function requestedAtBoot() {
  const keys = new Set()
  for (const match of userData.matchAll(/write_app_secrets\s+"([^"]*)"/g)) {
    for (const key of match[1].split(/\s+/)) {
      const trimmed = key.replace(/\\$/, "").trim()
      if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) keys.add(trimmed)
    }
  }
  if (keys.size === 0) throw new Error("tofu/user-data.sh.tftpl no longer calls write_app_secrets")
  return keys
}

/** Non-secret configuration written straight into the env file. */
function writtenDirectly() {
  const keys = new Set()
  for (const match of userData.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) keys.add(match[1])
  for (const match of userData.matchAll(/echo\s+"([A-Z][A-Z0-9_]*)=/g)) keys.add(match[1])
  return keys
}

const inParameterStore = parameterStoreKeys()
const requested = requestedAtBoot()
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
  The silent one. `write_app_secrets` filters what SSM returned by this list, so a name that is not
  a parameter is not an error — it is an absence, and absence is indistinguishable from a value
  nobody happened to need on this boot.
*/
for (const key of [...requested].sort()) {
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
for (const key of [...inParameterStore].sort()) {
  if (!requested.has(key) && !direct.has(key)) {
    warnings.push(
      `${key} is written to Parameter Store by put-app-secrets.sh but no write_app_secrets call ` +
        `asks for it, so no instance ever reads it.`,
    )
  }
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
  const present = new Set(JSON.parse(raw).map((name) => name.split("/").pop()))

  for (const key of [...requested].sort()) {
    if (!present.has(key)) {
      problems.push(
        `${key} is requested at boot and is not in Parameter Store at ${path}. ` +
          `It is most likely empty in the .env that put-app-secrets.sh was run against, ` +
          `which that script skips silently.`,
      )
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
