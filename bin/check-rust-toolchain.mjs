#!/usr/bin/env node
/**
 * Fail when a Rust image is built with a compiler the repository does not support.
 *
 * `rust-toolchain.toml` is the version rustup installs for everyone working in the repo, and it is
 * what `cargo clippy` and `cargo test` run under in CI. The Dockerfiles pin their own base image,
 * and nothing connected the two — so all four sat on `rust:1.85-alpine` while the repo moved to
 * 1.93.
 *
 * That did not fail loudly. `pg-proxy` and `valkey-proxy` built fine, because their dependency
 * trees do not happen to reach a crate with a newer `rust-version`. `metering-agent` and
 * `search-proxy` pull in the `icu_*` crates and failed outright. So two of four images were being
 * built by a compiler eight minor versions behind the one every test ran under, and the only
 * signal was that the other two broke.
 *
 * A version skew that shows up in some images and not others is worse than one that shows up in
 * none, because the two that work are taken as evidence that the pin is fine.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const toolchain = readFileSync("rust-toolchain.toml", "utf8")
const pinned = /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1]

if (pinned === undefined) {
  console.error("FAIL: rust-toolchain.toml has no channel")
  process.exit(1)
}

// "1.93.0" in the toolchain file, "1.93" on Docker Hub: the image tags carry major.minor only.
const [major, minor] = pinned.split(".")
const expected = `${major}.${minor}`

const problems = []
let checked = 0

for (const file of readdirSync("docker").filter((name) => name.endsWith(".Dockerfile"))) {
  const contents = readFileSync(join("docker", file), "utf8")

  for (const [line, version] of contents.matchAll(/^FROM.*\brust:([\d.]+)/gm)) {
    checked += 1
    if (version !== expected) {
      problems.push(`  docker/${file}: rust:${version}, but rust-toolchain.toml pins ${pinned}`)
    }
    void line
  }
}

// The workflow pins the toolchain a third time, for the job that actually runs clippy and the
// tests. If that one drifts, CI is green under a compiler nobody else uses.
const workflow = readFileSync(join(".github", "workflows", "ci.yml"), "utf8")
let workflowPins = 0

for (const [line, version] of workflow.matchAll(/^\s*toolchain:\s*"([^"]+)"/gm)) {
  workflowPins += 1
  if (version !== pinned) {
    problems.push(
      `  .github/workflows/ci.yml: toolchain "${version}", but rust-toolchain.toml pins ${pinned}`,
    )
  }
  void line
}

if (workflowPins === 0) {
  console.error("FAIL: no `toolchain:` pin found in ci.yml. Guard is blind.")
  process.exit(1)
}

checked += workflowPins

if (checked === 0) {
  // The guard silently passing because its own regex stopped matching is the failure mode this
  // whole file exists to prevent.
  console.error("FAIL: no `FROM ... rust:<version>` line found in any Dockerfile. Guard is blind.")
  process.exit(1)
}

if (problems.length > 0) {
  console.error(`Rust image pins disagree with rust-toolchain.toml (${pinned}):\n`)
  console.error(problems.join("\n"))
  console.error("\nBuild them with the compiler the tests run under, or move the toolchain pin.")
  process.exit(1)
}

console.log(`All ${checked} Rust toolchain pin(s) match rust-toolchain.toml (${pinned}).`)
