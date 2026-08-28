import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
      metadata.summary === undefined
    ) {
      throw new Error(`${file} is missing slug, title, or summary`)
    }
    return { ...metadata, content: match[2].trim() }
  })

writeFileSync(
  join(directory, "../../lib/docs.generated.ts"),
  `// Generated from src/content/docs/*.md by scripts/generate-docs.ts.\nexport const GENERATED_DOCS = ${JSON.stringify(docs, null, 2)} as const\n`,
)
