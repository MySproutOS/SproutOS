import type { Dirent } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"

/**
 * What the model is shown.
 *
 * Not the repository — a bounded, chosen sample of it. Sending everything is impossible for any
 * real project and pointless besides: what a repository *needs to run* lives in a dozen
 * well-known files, and a model reading 4,000 source files to find them is spending the customer's
 * money on the part it is worst at.
 *
 * The tree gives it the shape; the manifests give it the facts.
 */

/** Files whose contents answer "what is this and what does it need". */
const INTERESTING = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "Procfile",
  "fly.toml",
  "render.yaml",
  "app.json",
  ".env.example",
  ".env.sample",
  "README.md",
  "readme.md",
])

/** Never worth reading, and expensive to walk. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".terraform",
])

/** One file's share of the budget. A 5 MB README should not crowd out package.json. */
const PER_FILE_BYTES = 24_000
const TREE_ENTRIES = 400

export type RepoEvidence = {
  tree: string[]
  files: { path: string; content: string; truncated: boolean }[]
}

export async function gatherEvidence(root: string): Promise<RepoEvidence> {
  const tree = await listTree(root)
  const files: RepoEvidence["files"] = []

  for (const path of tree) {
    const name = path.split("/").pop() ?? ""
    if (!INTERESTING.has(name)) continue

    const absolute = join(root, path)
    try {
      const info = await stat(absolute)
      if (!info.isFile()) continue

      const raw = await readFile(absolute, "utf8")
      const truncated = raw.length > PER_FILE_BYTES
      files.push({ path, content: truncated ? raw.slice(0, PER_FILE_BYTES) : raw, truncated })
    } catch {
      // A file listed but unreadable — a broken symlink, a permissions oddity — is not worth
      // failing an analysis over.
    }
  }

  return { tree, files }
}

async function listTree(root: string): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [root]

  while (queue.length > 0 && found.length < TREE_ENTRIES) {
    const dir = queue.shift()!
    // Typed explicitly: the inferred return of readdir picks the Buffer overload, so `entry.name`
    // comes back as a buffer rather than a string.
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (found.length >= TREE_ENTRIES) break
      if (entry.name.startsWith(".") && entry.isDirectory() && entry.name !== ".github") continue
      if (SKIP_DIRS.has(entry.name)) continue

      const absolute = join(dir, entry.name)
      const path = relative(root, absolute)
      if (entry.isDirectory()) {
        // Breadth-first, so a deep vendored tree cannot consume the whole budget before the
        // top-level files that actually matter are seen.
        queue.push(absolute)
        found.push(`${path}/`)
      } else {
        found.push(path)
      }
    }
  }

  return found.sort((a, b) => a.localeCompare(b))
}

/** The evidence as one prompt-shaped string, with the cheapest signal first. */
export function renderEvidence(evidence: RepoEvidence): string {
  const parts: string[] = [
    "## Repository tree",
    "```",
    ...evidence.tree.slice(0, TREE_ENTRIES),
    "```",
  ]

  for (const file of evidence.files) {
    parts.push(`## ${file.path}${file.truncated ? " (truncated)" : ""}`, "```", file.content, "```")
  }

  return parts.join("\n")
}
