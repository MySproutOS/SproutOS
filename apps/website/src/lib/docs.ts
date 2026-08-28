import { GENERATED_DOCS } from "./docs.generated"

export type DocSection = { heading: string; body: string[] }
export type Doc = {
  slug: string
  title: string
  summary: string
  content: string
  sections: DocSection[]
}

function parseDoc(input: { slug: string; title: string; summary: string; content: string }): Doc {
  const { slug, title, summary, content } = input
  const sections: DocSection[] = []
  let current: DocSection | undefined
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), body: [] }
      sections.push(current)
    } else if (current !== undefined && line.trim() !== "") {
      current.body.push(line.replace(/^[-*]\s+/, "").trim())
    }
  }

  return { slug, title, summary, content, sections }
}

export const DOCS: Doc[] = GENERATED_DOCS.map(parseDoc)

export function docBySlug(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug)
}

export function searchableText(doc: Doc): string {
  return [doc.title, doc.summary, doc.content].join(" ").toLowerCase()
}

export type DocMatch = { doc: Doc; heading?: string }

export function searchDocs(query: string): DocMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return DOCS.map((doc) => ({ doc }))
  return DOCS.filter((doc) => terms.every((term) => searchableText(doc).includes(term))).map(
    (doc) => {
      const heading = doc.sections.find((section) =>
        terms.every((term) => section.heading.toLowerCase().includes(term)),
      )?.heading
      return heading === undefined ? { doc } : { doc, heading }
    },
  )
}
