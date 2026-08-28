import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { format } from "oxfmt"

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

const outputPath = join(directory, "../../lib/docs.generated.ts")
const source = `// Generated from src/content/docs/*.md by scripts/generate-docs.ts.\nexport const GENERATED_DOCS = ${JSON.stringify(docs, null, 2)} as const\n`
async function writeGeneratedDocs(): Promise<void> {
  const formatted = await format(outputPath, source, { semi: false })
  if (formatted.errors.length > 0) {
    throw new Error(`Could not format generated docs: ${formatted.errors[0]?.message}`)
  }
  writeFileSync(outputPath, formatted.code)
}

void writeGeneratedDocs().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
