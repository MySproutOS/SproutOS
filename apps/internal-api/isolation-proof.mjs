#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/use-unknown-in-catch-callback-variable -- This rollout executable is a JavaScript boundary over the native CommonJS package and Node globals outside the application TypeScript graph. */
/**
 * Rollout-only proof for the exact ECS worker isolation boundary.
 *
 * This is intentionally not a job handler and never runs during normal worker startup. An operator
 * invokes it through audited SSM plus `docker exec` with immutable signed proof-artifact
 * coordinates. It prints only the native status and structured result/error code; it never prints
 * the worker environment or the proof sentinel.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const ALLOWED_SHA256 = "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df"
const EXPECTED_ERROR_CODES = new Set(["plugin_output_limit", "plugin_timeout"])
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}

export function probeConfiguration() {
  const reference = required("PROBE_REFERENCE")
  const digest = required("PROBE_DIGEST")
  const sourceCommit = required("PROBE_SOURCE_COMMIT")
  const expectedError = process.env.PROBE_EXPECT_ERROR

  if (!/^ghcr\.io\/mysproutos\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u.test(reference)) {
    throw new Error("PROBE_REFERENCE must be an immutable MySproutOS GHCR digest reference")
  }
  if (!SHA256.test(digest)) throw new Error("PROBE_DIGEST must be a lowercase SHA-256 digest")
  if (!COMMIT.test(sourceCommit)) {
    throw new Error("PROBE_SOURCE_COMMIT must be a lowercase 40-character Git commit")
  }
  if (expectedError !== undefined && !EXPECTED_ERROR_CODES.has(expectedError)) {
    throw new Error("PROBE_EXPECT_ERROR must be plugin_output_limit or plugin_timeout")
  }
  return { reference, digest, sourceCommit, expectedError }
}

function request(configuration, workspacePath) {
  return {
    workspacePath,
    pluginReference: configuration.reference,
    pluginDigest: configuration.digest,
    deploymentTemplatesCommit: configuration.sourceCommit,
    request: {
      protocol_version: 1,
      workspace: "/workspace",
      template: {
        id: "ecs-isolation-proof",
        catalogue_digest: configuration.digest,
        manifest_digest: configuration.digest,
        plugin_digest: configuration.digest,
        upstream_repository: "https://github.com/MySproutOS/Deployment-Templates",
        upstream_commit: configuration.sourceCommit,
      },
      deployment: { preset: "static", capabilities: [] },
      services: [],
      user_inputs: [],
      generated_inputs: [],
    },
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function assertCleanFailureWorkspace(workspacePath, expectedError) {
  const entries = (await readdir(workspacePath)).filter((entry) => entry !== ".git")
  if (entries.length !== 0) {
    throw new Error(`${expectedError} left unexpected workspace entries`)
  }
  if (await exists(join(workspacePath, ".git", "denied"))) {
    throw new Error(`${expectedError} modified protected Git metadata`)
  }
  if (expectedError === "plugin_timeout") {
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    if (await exists(join(workspacePath, "descendant-survived"))) {
      throw new Error("plugin_timeout left a surviving descendant")
    }
  }
}

async function assertSuccessfulBoundary(result, workspacePath) {
  const expectedChange = {
    path: "allowed",
    kind: "create",
    size: 2,
    before_sha256: null,
    sha256: ALLOWED_SHA256,
  }
  if (JSON.stringify(result.changes) !== JSON.stringify([expectedChange])) {
    throw new Error("isolation proof returned an unexpected verified workspace diff")
  }
  if ((await readFile(join(workspacePath, "allowed"), "utf8")) !== "ok") {
    throw new Error("isolation proof did not create the exact allowed file")
  }
  if (await exists(join(workspacePath, ".git", "denied"))) {
    throw new Error("isolation proof modified protected Git metadata")
  }
  if (await exists("/outside")) throw new Error("isolation proof escaped the workspace")
}

async function run() {
  const configuration = probeConfiguration()
  if (await exists("/outside")) throw new Error("/outside exists before the proof; refusing to run")

  const workspacePath = await mkdtemp(join(tmpdir(), "sproutos-isolation-proof-"))
  try {
    await execFileAsync("git", ["init", "--quiet", workspacePath], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    })
    const binding = await import("@sproutos/sprout-node")
    const status = binding.nativeRuntimeStatus()
    if (!status.available || status.pluginTarget !== "linux/arm64") {
      throw new Error("native runtime is not the production Linux arm64 target")
    }
    process.stdout.write(`${JSON.stringify({ phase: "runtime", status })}\n`)

    try {
      const result = await binding.applyTemplate(request(configuration, workspacePath))
      if (configuration.expectedError !== undefined) {
        throw new Error(`expected ${configuration.expectedError}, but the proof succeeded`)
      }
      await assertSuccessfulBoundary(result, workspacePath)
      process.stdout.write(`${JSON.stringify({ phase: "apply", status: "ok", result })}\n`)
    } catch (error) {
      if (configuration.expectedError === undefined) throw error
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined
      if (code !== configuration.expectedError) {
        throw new Error(`expected ${configuration.expectedError}, received ${code ?? "no code"}`, {
          cause: error,
        })
      }
      await assertCleanFailureWorkspace(workspacePath, configuration.expectedError)
      process.stdout.write(
        `${JSON.stringify({ phase: "apply", status: "expected_error", code })}\n`,
      )
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

async function selfTest() {
  if (!SHA256.test(`sha256:${"a".repeat(64)}`) || !COMMIT.test("b".repeat(40))) {
    throw new Error("proof coordinate validation self-test failed")
  }
  const workspacePath = await mkdtemp(join(tmpdir(), "sproutos-isolation-self-test-"))
  try {
    await mkdir(join(workspacePath, ".git"))
    await writeFile(join(workspacePath, "allowed"), "ok")
    await assertSuccessfulBoundary(
      {
        changes: [
          {
            path: "allowed",
            kind: "create",
            size: 2,
            before_sha256: null,
            sha256: ALLOWED_SHA256,
          },
        ],
      },
      workspacePath,
    )
    await rm(join(workspacePath, "allowed"))
    await assertCleanFailureWorkspace(workspacePath, "plugin_output_limit")
    process.stdout.write("isolation proof harness self-test passed\n")
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const operation = process.argv.includes("--self-test") ? selfTest() : run()
  operation.catch((error) => {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "proof_failed"
    // Do not print the error message: a broken isolation boundary could have put a caller secret in
    // plugin stderr, and native plugin-failure messages intentionally retain bounded stderr.
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`)
    process.exitCode = 1
  })
}
