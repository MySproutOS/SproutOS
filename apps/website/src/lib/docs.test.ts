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

      /*
        The index no longer carries the Markdown source — it carries the plain text Markdoc
        produced, because the raw source is a server-side concern and this module is imported by a
        client component. So the check is that the derivation ran and landed on this page's own
        content, rather than that two copies of one string match.

        An empty `text` is the failure worth naming: it is what a traversal that mishandles the
        shape of the tree produces, and it turns search into a box that finds nothing while looking
        like it works.
      */
      expect(generated.text.length).toBeGreaterThan(0)
      const source = markdown.find((file) => file.includes(`slug: ${generated.slug}`))!
      for (const heading of generated.headings) {
        expect(source).toContain(heading.title)
        expect(heading.id.length).toBeGreaterThan(0)
      }
    }
  })
  it("covers what the brief asks for", () => {
    const slugs = DOCS.map((doc) => doc.slug)

    // The complete onboarding path, plus the original operational references.
    expect(slugs).toContain("quickstart")
    expect(slugs).toContain("organizations-and-access")
    expect(slugs).toContain("projects-and-groups")
    expect(slugs).toContain("backend-services")
    expect(slugs).toContain("postgres")
    expect(slugs).toContain("valkey")
    expect(slugs).toContain("opensearch")
    expect(slugs).toContain("workflows")
    expect(slugs).toContain("workflow-editor")
    expect(slugs).toContain("repository-workflows")
    expect(slugs).toContain("agent-model-providers")
    expect(slugs).toContain("agent-sandboxes")
    expect(slugs).toContain("coding-agent-skill")
    expect(slugs).toContain("deployments")
    expect(slugs).toContain("environment-variables")
    expect(slugs).toContain("domains-and-rollbacks")
    expect(slugs).toContain("observability")
    expect(slugs).toContain("store-and-updates")
    expect(slugs).toContain("background-workers")
    expect(slugs).toContain("limits")
    expect(slugs).toContain("billing")
    expect(slugs).toContain("connecting")
    expect(slugs).toContain("database-migrations")
    expect(slugs).toContain("navigation")
    expect(slugs).toContain("oauth-applications")
    expect(slugs).toContain("github-action")
    expect(slugs).toContain("object-storage")
    expect(slugs).toContain("cli")
    expect(slugs).toContain("android-distribution")
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
    expect(text).toContain("sproutos.me/install.sh")
    expect(text).toContain("92e480886c7656e004c5bdf817e9733b35fd8c18")
    expect(text).toContain("fe614e86287579b2c987dd9fadef55fde12fea74")
    expect(text).not.toContain("sproutos-deploy-action@v1")
    expect(text).toContain("/docs/coding-agent-skill")
    expect(text).toContain(".agents/skills")
    expect(text).not.toContain("sprout_os_deploy")
    expect(text).not.toContain("sproutos-apps")
  })

  it("distinguishes standalone services, repository workflows, and visual definitions", () => {
    const services = searchableText(docBySlug("backend-services")!)
    const workflows = searchableText(docBySlug("workflows")!)
    const editor = searchableText(docBySlug("workflow-editor")!)

    expect(services).toContain("standalone means")
    expect(services).toContain("postgres, valkey, opensearch, and s3-compatible object storage")
    expect(workflows).toContain("bullmq typescript")
    expect(workflows).toContain("does not have a new definition button")
    expect(workflows).toContain("does not open the visual editor")
    expect(editor).toContain("exactly one trigger")
    expect(editor).toContain("does not create a new version")
  })

  it("documents provider selection, sandbox isolation, and the reusable agent skill", () => {
    const providers = searchableText(docBySlug("agent-model-providers")!)
    const sandboxes = searchableText(docBySlug("agent-sandboxes")!)
    const skill = searchableText(docBySlug("coding-agent-skill")!)

    expect(providers).toContain("openai and openrouter credentials run through codex")
    expect(providers).toContain("does not silently fall back")
    expect(sandboxes).toContain("does not inherit production runtime secrets")
    expect(sandboxes).toContain("sproutos/agent-")
    expect(skill).toContain(".agents/skills/sproutos/skill.md")
    expect(skill).toContain(".claude/skills/sproutos/skill.md")
    expect(skill).toContain("instructions, not a credential")
  })

  it("documents the current CLI contract and direct Android distribution", () => {
    const cli = searchableText(docBySlug("cli")!)
    const android = searchableText(docBySlug("android-distribution")!)

    expect(cli).toContain("sprout region list")
    expect(cli).toContain("--region us-east-1")
    expect(cli).toContain("sprout <version>")
    expect(cli).toContain("sproutos.me/install.sh")
    expect(cli).toContain("latest production-approved release")
    expect(cli).toContain("template-input-file")
    expect(cli).toContain("preserves the source or signed app store listing defaults")
    expect(cli).toContain("sprout service list")
    expect(cli).toContain("sprout deployment list my-site")
    expect(cli).not.toContain("sprout service list --project")
    expect(cli).not.toContain("sprout deployment list --project")
    expect(cli).toContain("sprout --json --yes project delete my-site")
    expect(android).toContain("does not publish google play tracks")
    expect(android).toContain("raw unsigned apk")
    expect(android).toContain("mobile mcp")
    expect(android).toContain("updates in place")
    expect(android).toContain("com.sproutos.store")
  })

  it("makes production migrations a customer-owned GitHub Actions dependency", () => {
    const migrations = docBySlug("database-migrations")
    const text = searchableText(migrations!)

    expect(text).toContain("dedicated sproutos migrator project")
    expect(text).toContain("migration-directory")
    expect(text).toContain("needs: migrate")
    expect(text).toContain("directly in ci")
    expect(text).toContain("does not scan a repository")
    expect(text).toContain("does not retry")
    expect(text).toContain("does not replace the github actions migration job")
  })

  it("documents the object-storage SDK and billing boundary", () => {
    const storage = docBySlug("object-storage")
    const text = searchableText(storage!)

    expect(text).toContain("s3_endpoint")
    expect(text).toContain("forcepathstyle")
    expect(text).toContain("path-style")
    expect(text).toContain("presigned urls")
    expect(text).toContain("48 hours")
    expect(text).toContain("static deployment")
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
