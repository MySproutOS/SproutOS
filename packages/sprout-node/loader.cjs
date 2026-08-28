"use strict"

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- This CommonJS loader must inspect Node runtime globals before the typed addon can load. */

const { existsSync } = require("node:fs")
const { join } = require("node:path")

function artifactNameFor(platform, architecture, glibc = true) {
  if (platform === "linux" && architecture === "arm64" && glibc) {
    return "sprout-node.linux-arm64-gnu.node"
  }
  if (platform === "darwin" && architecture === "arm64") {
    return "sprout-node.darwin-arm64.node"
  }
  if (platform === "darwin" && architecture === "x64") {
    return "sprout-node.darwin-x64.node"
  }
  throw new Error(
    `@sproutos/sprout-node has no verified native artifact for ${platform}/${architecture}${platform === "linux" && !glibc ? "/musl" : ""}`,
  )
}

function hasGlibc() {
  if (process.platform !== "linux") return true
  return Boolean(process.report?.getReport?.().header?.glibcVersionRuntime)
}

function loadNative() {
  const artifact = artifactNameFor(process.platform, process.arch, hasGlibc())
  const path = join(__dirname, artifact)
  if (!existsSync(path)) {
    throw new Error(`@sproutos/sprout-node native artifact is missing: ${artifact}`)
  }
  return require(path)
}

module.exports = { artifactNameFor, loadNative }
