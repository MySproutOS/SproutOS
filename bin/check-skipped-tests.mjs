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
  {
    suite: "@lib/envelope",
    count: 0,
    /*
      Zero, because they run.

      This said 8 and "LocalStack is gone. These now need real KMS", and LocalStack was not gone —
      it is in `docker-compose.yaml`, `bin/bootstrap-localstack.sh` creates the CMK, and its KMS was
      answering the whole time. What had gone was `AWS_ENDPOINT_URL` from `.env`, so every call
      reached the real AWS account named by the credentials beside it and found no
      `alias/sproutos-dev`.

      The suite that protects OAuth tokens and tenant database credentials was therefore skipping,
      and this file recorded the skip as a spending decision. A ceiling is only honest if the reason
      under it is; a wrong reason turns a temporary gap into a permanent one nobody revisits.
    */
    waiting: "nothing — LocalStack KMS, via AWS_ENDPOINT_URL in .env",
  },
  {
    suite: "@lib/services postgres",
    // Also zero. Same cause, plus `SERVICE_POSTGRES_*`, which was missing from `.template.env`
    // entirely while the Valkey and search equivalents beside it were present.
    count: 0,
    waiting: "nothing — LocalStack KMS and SERVICE_POSTGRES_* in .env, plus pg-proxy on :5433",
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
    waiting:
      "KUBE_SERVER — set in the `cluster` job, which runs this suite against a real kind cluster",
  },
  {
    suite: "@lib/jobs build",
    count: 1,
    waiting: "KUBE_SERVER and BUILD_REGISTRY — a cluster and a registry it can push to",
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
