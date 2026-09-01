import { GENERATED_POSTS } from "./blog.generated"

/*
  The blog index: metadata, headings and plain text.

  Free of renderable content on purpose — the trees live in `./blog-content`, which is server-only.
  Same split, and same reason, as `./docs.ts`.
*/

export type PostHeading = { id: string; level: number; title: string }
export type Post = {
  slug: string
  title: string
  summary: string
  /** Who the piece is written for — rendered as a label, not a filter. */
  audience: string
  /**
   * What kind of piece it is. Today every post is a "Worked example": it describes a mechanism
   * rather than a customer we have. The day there is a real deployment to write up, that post
   * carries a different kind and this one does not have to change.
   */
  kind: string
  date: string
  headings: readonly PostHeading[]
  text: string
}

export const POSTS: Post[] = GENERATED_POSTS.map((post) => ({
  ...post,
  headings: [...post.headings],
}))

export function postBySlug(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug)
}

/** Human date. Fixed to `en-GB` so the server and the browser cannot disagree and fail hydration. */
export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(date))
}
