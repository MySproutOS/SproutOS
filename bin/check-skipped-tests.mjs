#!/usr/bin/env node
/**
 * Fail when a test starts skipping that was not already known to skip.
 *
 * Several suites gate on a capability the environment may not have — LocalStack for KMS, a GitHub
 * App, an Anthropic key. Locally they run. In CI they skip, and a skipped test reads exactly like a
 * passing one in the summary: CI has never once executed the envelope-encryption suite that
 * protects OAuth tokens and database credentials, and nothing said so.
 *
 * The suites added later fail loudly in CI instead of skipping, which is the better pattern. These
 * predate it, and turning them red now would block every branch on credentials nobody has yet.
 *
 * So this is the middle position: the known skips are written down, with what each one is waiting
 * for, and the count is a ceiling. A newly-skipping test breaks the build. Nothing here is
 * invisible any more, and lowering the ceiling as credentials arrive is a one-line change.
 */
import { readFileSync } from "node:fs"

const KNOWN = [
  { suite: "@lib/envelope", count: 8, waiting: "LOCALSTACK_AUTH_TOKEN — KMS envelope encryption" },
  {
    suite: "@lib/services postgres",
    count: 6,
    waiting: "LOCALSTACK_AUTH_TOKEN — KMS, for tenant database provisioning",
  },
  {
    suite: "@api/internal projects",
    count: 7,
    waiting: "GITHUB_APP_CLIENT_SECRET / GITHUB_APP_PRIVATE_KEY",
  },
  { suite: "@api/internal agent", count: 6, waiting: "an Anthropic API key" },
  { suite: "@api/internal generate-openapi", count: 1, waiting: "a running API on :3001" },
  {
    suite: "@lib/jobs deploy",
    count: 1,
    waiting: "KUBE_SERVER — set in the `cluster` job, which runs this suite against a real kind cluster",
  },
]

const CEILING = KNOWN.reduce((total, entry) => total + entry.count, 0)

/**
 * Vitest's JSON reporter shape, narrowed to the two fields this reads.
 *
 * Typed rather than left as `any`: the whole job of this script is to notice when a number changes,
 * and a silent `undefined` flowing through an untyped parse is how it would come to report zero
 * skips forever while everything skipped.
 *
 * @typedef {{ name?: string, assertionResults?: { status?: string }[] }} ReportFile
 * @typedef {{ testResults?: ReportFile[] }} Report
 */

/** @type {Report} */
const report = /** @type {Report} */ (
  JSON.parse(readFileSync(process.argv[2] ?? "vitest-report.json", "utf8"))
)

/** @type {Map<string, number>} */
const skipped = new Map()

for (const file of report.testResults ?? []) {
  const name = String(file.name ?? "unknown").replace(`${process.cwd()}/`, "")
  const tests = Array.isArray(file.assertionResults) ? file.assertionResults : []

  for (const test of tests) {
    if (["pending", "skipped", "todo"].includes(test.status ?? "")) {
      skipped.set(name, (skipped.get(name) ?? 0) + 1)
    }
  }
}

const total = [...skipped.values()].reduce((a, b) => a + b, 0)

if (total === 0) {
  console.log("Every test ran. Nothing is waiting on a missing capability.")
  process.exit(0)
}

console.log(`${total} test(s) skipped, ceiling ${CEILING}:\n`)
for (const [file, count] of [...skipped].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${file}`)
}

console.log("\nKnown to be waiting on a capability this environment lacks:")
for (const entry of KNOWN) {
  console.log(`  ${String(entry.count).padStart(3)}  ${entry.suite} — ${entry.waiting}`)
}

if (total > CEILING) {
  console.error(
    `\nFAIL: ${total - CEILING} more test(s) are skipping than the ${CEILING} known to be blocked.\n` +
      "Something started skipping silently. Either fix it, or add it above with what it is waiting for.",
  )
  process.exit(1)
}

console.log("\nWithin the known ceiling. No new silent skips.")
