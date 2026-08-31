import { GENERATED_DOCS } from "./docs.generated"

/*
  The docs index: metadata, headings and search text.

  Deliberately free of renderable content. `docs/_components/search.tsx` is a client component and
  imports this module, so anything added here is downloaded by every visitor to every docs page.
  The Markdoc trees live in `./docs-content`, which is server-only.
*/

export type DocAudience = "user" | "developer"
export type DocHeading = { id: string; level: number; title: string }
export type Doc = {
  slug: string
  title: string
  summary: string
  audience: DocAudience
  category: string
  order: number
  headings: DocHeading[]
  /** Markdown stripped, for search. */
  text: string
}

type GeneratedDoc = Omit<Doc, "audience" | "headings"> & {
  audience: string
  headings: readonly DocHeading[]
}

function parseDoc(input: GeneratedDoc): Doc {
  return {
    ...input,
    // The generator rejects anything else, so this is a cast rather than a check.
    audience: input.audience as DocAudience,
    headings: [...input.headings],
  }
}

export const DOCS: Doc[] = GENERATED_DOCS.map((doc) => parseDoc(doc as unknown as GeneratedDoc))

export const AUDIENCE_LABEL: Record<DocAudience, string> = {
  user: "For users",
  developer: "For developers",
}

export const AUDIENCE_SLUG: Record<DocAudience, string> = {
  user: "users",
  developer: "developers",
}

export const AUDIENCE_SUMMARY: Record<DocAudience, string> = {
  user: "Running the apps you have, what they cost, and where everything lives.",
  developer: "Deploying your own code, connecting to services, and building on the API.",
}

export type DocCategory = { name: string; docs: Doc[] }
export type DocAudienceGroup = {
  audience: DocAudience
  label: string
  slug: string
  summary: string
  categories: DocCategory[]
  /** Every doc in the audience, flattened in sidebar order — what prev/next walks. */
  ordered: Doc[]
}

function groupAudience(audience: DocAudience): DocAudienceGroup {
  const docs = DOCS.filter((doc) => doc.audience === audience)
  const categories: DocCategory[] = []
  for (const doc of docs) {
    const existing = categories.find((category) => category.name === doc.category)
    if (existing === undefined) categories.push({ name: doc.category, docs: [doc] })
    else existing.docs.push(doc)
  }
  for (const category of categories) {
    category.docs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  }
  /*
    `order` is audience-wide, not per-category, so a category sits where its first doc sits.

    The alternative is a second field naming the category's own position, which is a number that has
    to agree with the per-doc one and eventually will not. Ordering the docs correctly is enough
    information to order the sections they fall into.
  */
  categories.sort((a, b) => (a.docs[0]?.order ?? 0) - (b.docs[0]?.order ?? 0))

  return {
    audience,
    label: AUDIENCE_LABEL[audience],
    slug: AUDIENCE_SLUG[audience],
    summary: AUDIENCE_SUMMARY[audience],
    categories,
    ordered: categories.flatMap((category) => category.docs),
  }
}

/** Users first: somebody who lands on `/docs` without knowing which they are is more often one. */
export const DOC_AUDIENCES: DocAudienceGroup[] = [groupAudience("user"), groupAudience("developer")]

export function docBySlug(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug)
}

export function audienceGroup(audience: DocAudience): DocAudienceGroup {
  const group = DOC_AUDIENCES.find((candidate) => candidate.audience === audience)
  if (group === undefined) throw new Error(`Unknown docs audience: ${audience}`)
  return group
}

/**
 * The doc before and after this one, staying inside its own audience.
 *
 * Walking the flat list across both would march a reader out of the user docs and into the OAuth
 * reference by pressing "next" one time too many, which is a worse outcome than running out of
 * pages.
 */
export function docNeighbours(doc: Doc): { previous: Doc | undefined; next: Doc | undefined } {
  const { ordered } = audienceGroup(doc.audience)
  const index = ordered.findIndex((candidate) => candidate.slug === doc.slug)
  return { previous: ordered[index - 1], next: ordered[index + 1] }
}

export function searchableText(doc: Doc): string {
  return [doc.title, doc.summary, doc.text].join(" ").toLowerCase()
}

export type DocMatch = { doc: Doc; heading?: string }

export function searchDocs(query: string): DocMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return DOCS.map((doc) => ({ doc }))
  return DOCS.filter((doc) => terms.every((term) => searchableText(doc).includes(term))).map(
    (doc) => {
      const heading = doc.headings.find((section) =>
        terms.every((term) => section.title.toLowerCase().includes(term)),
      )?.title
      return heading === undefined ? { doc } : { doc, heading }
    },
  )
}
