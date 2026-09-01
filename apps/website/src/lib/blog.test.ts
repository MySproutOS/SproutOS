import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatPostDate, POSTS, postBySlug } from "./blog"

/**
 * The posts are content and mostly cannot be tested. What can is that the generated index matches
 * the sources, that the ordering is the one a blog needs, and that the honesty label is present —
 * that last one is the whole reason the field exists.
 */
describe("the blog", () => {
  it("generates one entry per Markdown source", () => {
    const directory = join(import.meta.dirname, "../content/blog")
    const sources = readdirSync(directory).filter((file) => file.endsWith(".md"))

    expect(POSTS).toHaveLength(sources.length)
    for (const post of POSTS) {
      const source = sources
        .map((file) => readFileSync(join(directory, file), "utf8"))
        .find((text) => text.includes(`slug: ${post.slug}`))

      expect(source).toBeDefined()
      // An empty index is what a traversal that mishandles the tree shape produces, and it turns
      // every post into a page with a title and no findable body.
      expect(post.text.length).toBeGreaterThan(0)
      for (const heading of post.headings) {
        expect(source).toContain(heading.title)
        expect(heading.id.length).toBeGreaterThan(0)
      }
    }
  })

  it("orders newest first", () => {
    const dates = POSTS.map((post) => Date.parse(post.date))
    expect([...dates].sort((a, b) => b - a)).toEqual(dates)
  })

  it("labels every post with what kind of piece it is", () => {
    /*
      There are no customers yet, so a post that reads as a case study would be claiming something
      untrue. Every post carries a `kind`, and today every one of them is a worked example.
    */
    for (const post of POSTS) {
      expect(post.kind.length).toBeGreaterThan(0)
      expect(post.audience.length).toBeGreaterThan(0)
    }
  })

  it("has a unique slug per post", () => {
    expect(new Set(POSTS.map((post) => post.slug)).size).toBe(POSTS.length)
  })

  it("formats dates without depending on the machine's locale or zone", () => {
    // A locale-dependent format renders differently on the server and in the browser, which fails
    // hydration rather than merely looking odd.
    expect(formatPostDate("2026-09-01")).toBe("1 September 2026")
  })

  it("finds a post by slug and misses cleanly", () => {
    expect(postBySlug(POSTS[0].slug)?.title).toBe(POSTS[0].title)
    expect(postBySlug("not-a-post")).toBeUndefined()
  })
})
