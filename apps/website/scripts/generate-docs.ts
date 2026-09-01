import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Markdoc, { type RenderableTreeNode, Tag } from "@markdoc/markdoc"
import { format } from "oxfmt"
import { config } from "../src/lib/markdoc-config"

/**
 * `/docs/users` and `/docs/developers` are static route segments. Next resolves a static segment
 * before `[slug]`, so a doc claiming one of these would not 404 — it would silently render the
 * audience landing page instead and the doc would simply stop existing. Fail the build instead.
 */
const RESERVED_SLUGS = new Set(["users", "developers"])

const AUDIENCES = new Set(["user", "developer"])

type Heading = { id: string; level: number; title: string }

/**
 * Headings, taken from the tree that will actually be rendered.
 *
 * The contents list used to be built by splitting the raw markdown on `## `, while the ids were
 * computed separately at render time from the React children. Two derivations of one fact, and the
 * failure mode was silent: a contents entry whose link scrolled nowhere. Reading both out of the
 * transformed tree makes them the same fact.
 */
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
      // Markdoc types `attributes` as `Record<string, any>`; read through `unknown` so the
      // `typeof` guards below are load-bearing rather than decorative.
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

/**
 * Plain text for the client-side search index — no markup, no renderable tree.
 *
 * Takes an array as well as a node: the document node returns its children directly, so the top of
 * every tree is an array. Missing that case is not a type error at runtime, it just quietly yields
 * an empty index, which is why `docs.test.ts` asserts on found terms rather than on shape.
 */
function plainText(
  node: RenderableTreeNode | RenderableTreeNode[],
  parts: string[] = [],
): string[] {
  if (Array.isArray(node)) {
    for (const child of node) plainText(child, parts)
  } else if (typeof node === "string") {
    parts.push(node)
  } else if (node instanceof Tag) {
    /*
      Link targets are content here, not markup.

      The one release tag a reader is most likely to search for — `cli-v0.1.2` — appears only inside
      a URL, and the old index included it by accident because it searched the raw Markdown. Pulling
      `href` out deliberately keeps that findable now that the index is built from the tree, where
      attributes are not children.
    */
    const href: unknown = node.attributes.href
    if (typeof href === "string") parts.push(href)
    for (const child of node.children) plainText(child, parts)
  }
  return parts
}

const directory = join(import.meta.dirname, "../src/content/docs")
const docs = readdirSync(directory)
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
    if (
      metadata.slug === undefined ||
      metadata.title === undefined ||
      metadata.summary === undefined ||
      metadata.audience === undefined ||
      metadata.category === undefined ||
      metadata.order === undefined
    ) {
      throw new Error(`${file} is missing slug, title, summary, audience, category, or order`)
    }
    if (RESERVED_SLUGS.has(metadata.slug)) {
      throw new Error(
        `${file} uses the reserved slug "${metadata.slug}" — /docs/${metadata.slug} is an audience landing page`,
      )
    }
    if (!AUDIENCES.has(metadata.audience)) {
      throw new Error(`${file} has audience "${metadata.audience}", expected user or developer`)
    }
    const order = Number(metadata.order)
    if (!Number.isInteger(order)) {
      throw new Error(`${file} has a non-integer order "${metadata.order}"`)
    }

    const body = match[2].trim()
    const ast = Markdoc.parse(body)

    /*
      Validation is a build-time gate, not a warning nobody reads.

      A malformed tag or an unknown attribute renders as nothing at all, so a broken doc looks like
      a doc that is simply missing a paragraph. Failing here means the person who wrote it finds
      out, rather than a reader.
    */
    const errors = Markdoc.validate(ast, config).filter((error) => error.error.level === "critical")
    if (errors.length > 0) {
      const first = errors[0]
      throw new Error(`${file}: ${first.error.message} (line ${first.lines[0] ?? 0})`)
    }

    const content = Markdoc.transform(ast, config)
    const headings = collectHeadings(content)

    // Every heading needs a unique anchor, or one of two identically-named sections is unreachable.
    const ids = headings.map((h) => h.id)
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    if (duplicate !== undefined) {
      throw new Error(`${file} has two headings with the anchor "#${duplicate}"`)
    }

    const text = plainText(content).join(" ").replace(/\s+/g, " ").trim()
    if (text === "") throw new Error(`${file} produced an empty search index`)

    return {
      slug: metadata.slug,
      title: metadata.title,
      summary: metadata.summary,
      audience: metadata.audience,
      category: metadata.category,
      order,
      headings,
      // Markdown stripped: this is what the client-side search filters over, so it should not ship
      // backticks and pipe tables to the browser.
      text,
      content,
    }
  })

/*
  Two modules, deliberately.

  `search.tsx` is a client component and imports the docs index, so everything in that module is
  downloaded by every visitor. The renderable trees are several times the size of the prose and are
  needed only by the server component that renders a page, so they live in their own module that
  the client never imports. Putting both in one file would quietly ship the entire corpus, twice
  over, to the browser.
*/
const indexPath = join(directory, "../../lib/docs.generated.ts")
const contentPath = join(directory, "../../lib/docs-content.generated.ts")

const indexSource = `// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
// Metadata and search text only — safe to import from a client component.
export const GENERATED_DOCS = ${JSON.stringify(
  docs.map(({ content: _content, ...rest }) => rest),
  null,
  2,
)} as const
`

const contentSource = `// Generated from src/content/docs/*.md by scripts/generate-docs.ts.
// Markdoc renderable trees. Server-only: see the note in scripts/generate-docs.ts.
import type { RenderableTreeNode } from "@markdoc/markdoc"

export const GENERATED_DOC_CONTENT: Record<string, RenderableTreeNode[]> = ${JSON.stringify(
  Object.fromEntries(docs.map((doc) => [doc.slug, doc.content])),
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
