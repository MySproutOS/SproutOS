import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Markdoc, { type RenderableTreeNode, Tag } from "@markdoc/markdoc"
import { format } from "oxfmt"
import { config } from "../src/lib/markdoc-config"

/*
  The blog, built the same way the docs are.

  Same Markdoc config, so a post and a doc render through the same components and cannot drift in
  how a heading anchors or a link behaves. Same two-module split, and for the same reason: the index
  is imported by a client component, the renderable trees are not.
*/

type Heading = { id: string; level: number; title: string }

function collectHeadings(
  node: RenderableTreeNode | RenderableTreeNode[],
  headings: Heading[] = [],
): Heading[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHeadings(child, headings)
  } else if (node instanceof Tag) {
    if (node.name === "Heading") {
      const title = node.children
        .map((child) => (typeof child === "string" ? child : ""))
        .join("")
        .trim()
      const id: unknown = node.attributes.id
      const level: unknown = node.attributes.level
      if (title !== "" && typeof id === "string" && typeof level === "number") {
        headings.push({ id, level, title })
      }
    }
    for (const child of node.children) collectHeadings(child, headings)
  }
  return headings
}

function plainText(
  node: RenderableTreeNode | RenderableTreeNode[],
  parts: string[] = [],
): string[] {
  if (Array.isArray(node)) {
    for (const child of node) plainText(child, parts)
  } else if (typeof node === "string") {
    parts.push(node)
  } else if (node instanceof Tag) {
    for (const child of node.children) plainText(child, parts)
  }
  return parts
}

const REQUIRED = ["slug", "title", "summary", "audience", "kind", "date"] as const

const directory = join(import.meta.dirname, "../src/content/blog")
const posts = readdirSync(directory)
  .filter((file) => file.endsWith(".md"))
  .toSorted()
  .map((file) => {
    const source = readFileSync(join(directory, file), "utf8")
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
    if (match === null) throw new Error(`${file} has no front matter`)
    const metadata = Object.fromEntries(
      match[1]
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":")
          if (separator < 1) throw new Error(`Invalid metadata in ${file}`)
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        }),
    )
    for (const key of REQUIRED) {
      if (metadata[key] === undefined) throw new Error(`${file} is missing ${key}`)
    }
    // Sorted on and rendered as a date; a typo here becomes "Invalid Date" in the browser.
    if (Number.isNaN(Date.parse(metadata.date))) {
      throw new Error(`${file} has an unparseable date "${metadata.date}"`)
    }

    const ast = Markdoc.parse(match[2].trim())
    const errors = Markdoc.validate(ast, config).filter((e) => e.error.level === "critical")
    if (errors.length > 0) {
      const first = errors[0]
      throw new Error(`${file}: ${first.error.message} (line ${first.lines[0] ?? 0})`)
    }

    const content = Markdoc.transform(ast, config)
    const text = plainText(content).join(" ").replace(/\s+/g, " ").trim()
    if (text === "") throw new Error(`${file} produced an empty search index`)

    return {
      slug: metadata.slug,
      title: metadata.title,
      summary: metadata.summary,
      audience: metadata.audience,
      kind: metadata.kind,
      date: metadata.date,
      headings: collectHeadings(content),
      text,
      content,
    }
  })
  // Newest first, which is the only order a blog index is ever wanted in.
  .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))

const indexPath = join(directory, "../../lib/blog.generated.ts")
const contentPath = join(directory, "../../lib/blog-content.generated.ts")

const indexSource = `// Generated from src/content/blog/*.md by scripts/generate-blog.ts.
// Metadata and search text only — safe to import from a client component.
export const GENERATED_POSTS = ${JSON.stringify(
  posts.map(({ content: _content, ...rest }) => rest),
  null,
  2,
)} as const
`

const contentSource = `// Generated from src/content/blog/*.md by scripts/generate-blog.ts.
// Markdoc renderable trees. Server-only: imported through src/lib/blog-content.ts.
import type { RenderableTreeNode } from "@markdoc/markdoc"

export const GENERATED_POST_CONTENT: Record<string, RenderableTreeNode[]> = ${JSON.stringify(
  Object.fromEntries(posts.map((post) => [post.slug, post.content])),
  null,
  2,
)}
`

async function writeGenerated(path: string, source: string): Promise<void> {
  const formatted = await format(path, source, { semi: false })
  if (formatted.errors.length > 0) {
    throw new Error(`Could not format ${path}: ${formatted.errors[0]?.message}`)
  }
  writeFileSync(path, formatted.code)
}

void Promise.all([
  writeGenerated(indexPath, indexSource),
  writeGenerated(contentPath, contentSource),
]).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
