#!/usr/bin/env node
/**
 * Every workspace package an app imports must be one it declares.
 *
 * Three apps imported packages that appear nowhere in their `package.json` — `apps/website` reached
 * for `@lib/dao`, and both SPAs for `@ui/seo-shared`. They worked anyway: pnpm's virtual store
 * leaves every workspace package resolvable from the repo root, and `tsconfig.json` `paths` maps
 * several of them by hand, so neither the type-checker nor the bundler had any reason to object.
 *
 * That is a dependency that exists only by accident of layout. It survives exactly as long as
 * nothing changes the layout: a package published on its own, an install with a different linker, a
 * Docker build that copies one app's `node_modules` — any of these turns a working import into
 * `Cannot find package`, at build time, in the deployment rather than here.
 *
 * It also hides the real shape of the tree. `apps/frontends/dashboard` declared `@ui/spa-shared`
 * and imported `@ui/seo-shared`; the declaration described a dependency it did not have and omitted
 * the one it did.
 *
 * Undeclared imports fail. Declared-but-unused only warns: an unused dependency costs an install
 * entry, not a broken build, and a package may legitimately be kept for a re-export or a type-only
 * path this scan does not model.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

/** Workspace globs, flattened by hand: the file is read for its shape, not evaluated. */
const PACKAGE_DIRS = [
  "apps",
  "apps/frontends",
  "packages",
  "lib/typescript",
  "lib/typescript/utils",
  "lib/typescript/ui",
]

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"])

/**
 * @typedef {{
 *   name?: string,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 * }} Manifest
 * @typedef {{ dir: string, manifest: Manifest }} WorkspacePackage
 */

/**
 * @param {string} dir
 * @returns {Manifest | null}
 */
function packageJsonAt(dir) {
  try {
    return /** @type {Manifest} */ (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")))
  } catch {
    return null
  }
}

/** @returns {Map<string, WorkspacePackage>} */
function workspacePackages() {
  /** @type {Map<string, WorkspacePackage>} */
  const found = new Map()
  for (const parent of PACKAGE_DIRS) {
    let entries
    try {
      entries = readdirSync(join(ROOT, parent), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(ROOT, parent, entry.name)
      const manifest = packageJsonAt(dir)
      if (manifest === null || manifest.name === undefined) continue
      // `apps/frontends` is itself matched by the `apps/*` glob but holds no package of its own.
      found.set(manifest.name, { dir, manifest })
    }
  }
  return found
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const files = []
  /** @param {string} current */
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".next" ||
          entry.name === "dist" ||
          entry.name === "build"
        ) {
          continue
        }
        walk(full)
      } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push(full)
      }
    }
  }
  walk(dir)
  return files
}

/**
 * Imported specifiers, from `import`/`export ... from`, bare `import "x"`, and `require("x")`.
 *
 * Deliberately a regex rather than a parse: this runs over every source file in the repo on every
 * CI run, and the question it asks — does this string appear as a module specifier — does not need
 * a syntax tree. A specifier inside a comment or a string produces a false *declaration
 * requirement*, which is a harmless over-report, never a missed one.
 */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g

/**
 * @param {string} file
 * @returns {Set<string>}
 */
function importsIn(file) {
  const source = readFileSync(file, "utf8")
  /** @type {Set<string>} */
  const specifiers = new Set()
  for (const match of source.matchAll(SPECIFIER)) {
    if (match[1] !== undefined) specifiers.add(match[1])
  }
  return specifiers
}

/**
 * `@lib/dao/user/auth` belongs to `@lib/dao`; `kysely` belongs to nothing here.
 *
 * @param {string} specifier
 * @param {Set<string>} names
 * @returns {string | null}
 */
function owningPackage(specifier, names) {
  if (names.has(specifier)) return specifier
  const scoped = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier)
  return names.has(scoped) ? scoped : null
}

const packages = workspacePackages()
/** @type {Set<string>} */
const names = new Set(packages.keys())

/** @type {string[]} */
const failures = []
/** @type {string[]} */
const warnings = []

for (const [name, { dir, manifest }] of packages) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])

  /** @type {Map<string, string>} */
  const used = new Map()
  for (const file of sourceFiles(dir)) {
    for (const specifier of importsIn(file)) {
      const owner = owningPackage(specifier, names)
      if (owner === null || owner === name) continue
      if (!used.has(owner)) used.set(owner, relative(ROOT, file))
    }
  }

  for (const [owner, file] of used) {
    if (!declared.has(owner))
      failures.push(`${name} imports ${owner} without declaring it — first seen in ${file}`)
  }
  for (const owner of declared) {
    if (names.has(owner) && !used.has(owner))
      warnings.push(`${name} declares ${owner} and never imports it`)
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  console.error(
    `\n${failures.length} undeclared workspace ${failures.length === 1 ? "dependency" : "dependencies"}.`,
  )
  process.exit(1)
}

console.log(`ok: ${packages.size} workspace packages, every imported one declared.`)
