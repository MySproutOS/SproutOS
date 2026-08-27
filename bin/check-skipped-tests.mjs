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
    suite: "@lib/services object-storage",
    count: 2,
    /*
      IAM policy *enforcement* is a LocalStack Pro feature.

      The free image accepts every IAM call and evaluates no policy, so every credential behaves as
      root. These two are the assertions that would prove tenant isolation rather than describe it —
      a cross-tenant read being refused, and a suspended credential being refused. The rest of the
      suite asserts the mechanism: that the policy document names one bucket ARN and no other, and
      that suspension removes the policy while leaving the key.

      Listed here so a green suite is never read as evidence that a tenant cannot reach another
      tenant's bucket. That is AWS's to enforce and this environment cannot see it.
    */
    waiting: "a policy engine that enforces — real AWS IAM, or LocalStack Pro",
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
    suite: "@lib/agent Daytona live",
    count: 4,
    waiting: "DAYTONA_API_KEY, DAYTONA_ORGANIZATION_ID and a built Daytona snapshot",
  },
  {
    suite: "@lib/jobs sandbox-stop live",
    count: 2,
    waiting:
      "Daytona credentials and a reachable control-plane Postgres; egress also requires SANDBOX_LIVE_EGRESS_CONTROL_PLANE=1 with the proxy's database",
  },
  {
    suite: "@api/internal metering Kafka live",
    count: 1,
    waiting: "a Kafka broker reachable from the test process",
  },
  {
    /*
      Waiting on a repository secret, not on a decision.

      These suites reach KMS, S3 and Secrets Manager through `AWS_ENDPOINT_URL`. On a developer's
      machine that is the LocalStack in `docker-compose.yaml` and they all run — locally the total
      skipped is three. In CI it is sixty-nine, because LocalStack has been token-gated since its
      OSS image was archived and this repository has no `LOCALSTACK_AUTH_TOKEN`.

      `.github/workflows/ci.yml` starts LocalStack when that secret exists. Adding it turns these
      back on, and this entry should then go to zero — which is the one-line change this file was
      written to make possible.

      **What is not being tested meanwhile is worth naming rather than summing:** envelope
      encryption, which protects every OAuth token and tenant database credential; the object-storage
      tenant boundary; Postgres service provisioning; and Lambda publish. They run before every
      commit on a machine that has LocalStack, and nowhere else.
    */
    suite: "LocalStack-dependent suites in CI",
    count: 51,
    waiting: "LOCALSTACK_AUTH_TOKEN as a repository secret",
  },
  {
    /*
      There is no cluster job any more.

      Two entries here waited on `KUBE_SERVER` and `BUILD_REGISTRY`, "set in the `cluster` job,
      which runs this suite against a real kind cluster". ADR 0026 replaced Kubernetes with Lambda
      and that job went with it, so the capability these were waiting for is one nothing will ever
      provide. They are one entry now, waiting on the thing that actually gates them.
    */
    suite: "@lib/jobs publish",
    count: 11,
    waiting:
      "LOCALSTACK_AUTH_TOKEN — Lambda, S3, CloudFront KVS, and Route53, via AWS_ENDPOINT_URL",
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
