import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { GENERATED_DOCS } from "./docs.generated"
import { DOCS, docBySlug, searchableText, searchDocs } from "./docs"

/**
 * The docs are content, and most of them cannot be tested. What can is that search finds them —
 * a search that misses a page answers confidently while missing it, which is worse than no search.
 */
describe("the documentation", () => {
  it("keeps the generated browser index synchronized with the Markdown sources", () => {
    const directory = join(import.meta.dirname, "../content/docs")
    const markdown = readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .map((file) => readFileSync(join(directory, file), "utf8"))

    expect(GENERATED_DOCS).toHaveLength(markdown.length)
    for (const generated of GENERATED_DOCS) {
      expect(markdown.some((source) => source.includes(`slug: ${generated.slug}`))).toBe(true)
      expect(markdown.some((source) => source.includes(generated.content))).toBe(true)
    }
  })
  it("covers what the brief asks for", () => {
    const slugs = DOCS.map((doc) => doc.slug)

    // The original operational pages plus the launch navigation and developer guides.
    expect(slugs).toContain("background-workers")
    expect(slugs).toContain("limits")
    expect(slugs).toContain("billing")
    expect(slugs).toContain("connecting")
    expect(slugs).toContain("navigation")
    expect(slugs).toContain("oauth-applications")
    expect(slugs).toContain("github-action")
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

  it("documents one CLI contract for Actions and local coding agents", () => {
    const deployments = docBySlug("github-action")
    const text = searchableText(deployments!)

    expect(text).toContain("thin wrapper around the published")
    expect(text).toContain("sprout deploy my-web-project")
    expect(text).toContain("deployment-templates")
    expect(text).toContain("cli-v0.1.2")
    expect(text).toContain("0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180")
    expect(text).toContain("c86dfdb7f055cb6cdf499b23f84ab91d640ca7a1")
    expect(text).not.toContain("sproutos-deploy-action@v1")
    expect(text).toContain("~/.codex/skills/sproutos/skill.md")
    expect(text).toContain("sandbox time or model usage")
    expect(text).not.toContain("sprout_os_deploy")
    expect(text).not.toContain("sproutos-apps")
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
    const [result] = searchDocs("Queue residency")

    expect(result?.doc.slug).toBe("billing")
    expect(result?.heading).toBe("Queue residency")
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
