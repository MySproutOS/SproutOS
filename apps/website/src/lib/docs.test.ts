import { describe, expect, it } from "vitest"
import { DOCS, docBySlug, searchableText, searchDocs } from "./docs"

/**
 * The docs are content, and most of them cannot be tested. What can is that search finds them —
 * a search that misses a page answers confidently while missing it, which is worse than no search.
 */
describe("the documentation", () => {
  it("covers what the brief asks for", () => {
    const slugs = DOCS.map((doc) => doc.slug)

    // §6.2, named: workers and open connections, limits, billing, and connecting to services.
    expect(slugs).toContain("background-workers")
    expect(slugs).toContain("limits")
    expect(slugs).toContain("billing")
    expect(slugs).toContain("connecting")
  })

  it("says the thing the docs exist to say", () => {
    /*
      The whole reason §6 is in the brief: "when we spin up users' background worker, they don't
      also continue the connection; otherwise, lambda will continuously run, wasting credits."

      A docs section that did not say this plainly would be a docs section that missed its point.
    */
    const workers = docBySlug("background-workers")
    const text = searchableText(workers!)

    expect(text).toContain("returns")
    expect(text).toContain("gb-seconds")
    expect(text).toContain("blocking read")
  })

  it("has a unique slug per page", () => {
    // Two pages on one slug is one page nobody can reach, and Next.js will not complain.
    expect(new Set(DOCS.map((doc) => doc.slug)).size).toBe(DOCS.length)
  })
})

describe("searching", () => {
  it("finds a page by a word in its body, not only its title", () => {
    // The index is derived from the page, so a term buried in a paragraph is findable. A
    // hand-maintained index is the one that misses these.
    const results = searchDocs("subscribe")

    expect(results.map((result) => result.doc.slug)).toContain("background-workers")
  })

  it("narrows as you add words, rather than widening", () => {
    const one = searchDocs("connection")
    const two = searchDocs("connection postgres")

    /*
      Every term must appear. Matching any term would make a longer query return *more*, so the page
      that matched only "the" would rank alongside the one that answered the question — which is
      how a search stops being trusted.
    */
    expect(two.length).toBeLessThanOrEqual(one.length)
    expect(one.length).toBeGreaterThan(0)
  })

  it("points at the heading that matched when there is one", () => {
    const [result] = searchDocs("Teams")

    expect(result?.doc.slug).toBe("billing")
    // So a result can send a reader to the part of a long page that answered them.
    expect(result?.heading).toBe("Teams")
  })

  it("is not case sensitive", () => {
    expect(searchDocs("GB-SECONDS").length).toBe(searchDocs("gb-seconds").length)
    expect(searchDocs("gb-seconds").length).toBeGreaterThan(0)
  })

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(searchDocs("").length).toBe(DOCS.length)
    expect(searchDocs("   ").length).toBe(DOCS.length)
    expect(searchDocs("kubernetes")).toHaveLength(0)
  })
})
