/* oxlint-disable no-await-in-loop */
import { db } from "@sproutos/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: user === null ? { "Content-Type": "application/json" } : authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

describe.skipIf(!reachable)("store routes", () => {
  let moderator: TestUser
  let stranger: TestUser
  let slug: string
  let organizationId: string

  const draftId = v7()
  const publishedId = v7()
  const draftSlug = `store-test-draft-${draftId.slice(-8)}`
  const publishedSlug = `store-test-live-${publishedId.slice(-8)}`

  beforeAll(async () => {
    moderator = await createTestUser("storemoderator")
    stranger = await createTestUser("storestranger")

    const created = await call("POST", "/v1/orgs", moderator, { name: "Store Suite" })
    if (created.status !== 201) {
      throw new Error(`fixture setup failed: POST /v1/orgs returned ${created.status}`)
    }
    organizationId = trackOrganization(created.json.id as string)
    slug = created.json.slug as string

    await db
      .insertInto("storeListing")
      .values([
        {
          id: draftId,
          slug: draftSlug,
          name: "Draft Only",
          tagline: "Submitted but never reviewed",
          descriptionMd: "This body has not been moderated and must never be served.",
          deploymentInstructionsPath: "SPROUT_OS_DEPLOY.md",
          deploymentSourceOwner: "SproutOS-Apps",
          deploymentSourceRepo: `draft-${draftId.slice(-8)}`,
          upstreamOwner: "example",
          upstreamRepo: `draft-${draftId.slice(-8)}`,
          upstreamRepoUrl: `https://github.com/example/draft-${draftId.slice(-8)}`,
          platform: "web",
          status: "draft",
        },
        {
          id: publishedId,
          slug: publishedSlug,
          name: "Sprout Widget Kit",
          tagline: "A published fixture with a distinctive tagline",
          descriptionMd: "Widgets, gadgets, and a search term nothing else uses: zorblatt.",
          deploymentInstructionsPath: "SPROUT_OS_DEPLOY.md",
          deploymentSourceOwner: "SproutOS-Apps",
          deploymentSourceRepo: `live-${publishedId.slice(-8)}`,
          readmeMd: "# Sprout Widget Kit\n\nInstall it.",
          upstreamOwner: "example",
          upstreamRepo: `live-${publishedId.slice(-8)}`,
          upstreamRepoUrl: `https://github.com/example/live-${publishedId.slice(-8)}`,
          platform: "web",
          status: "published",
        },
      ])
      .execute()

    await db
      .insertInto("storeListingTag")
      .values([
        { id: v7(), storeListingId: publishedId, tag: "storetest-widgets" },
        { id: v7(), storeListingId: draftId, tag: "storetest-widgets" },
      ])
      .execute()

    await db
      .insertInto("storeListingScreenshot")
      .values({
        id: v7(),
        storeListingId: publishedId,
        url: "https://cdn.example.com/shot.png",
        altText: "The widget list",
        sortOrder: 0,
      })
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("storeListing").where("id", "in", [draftId, publishedId]).execute()
    await cleanupFixtures()
  })

  /**
   * TASK 4. `/store` renders server-side for a visitor who has never signed in, so the route it
   * calls has to answer without a session — `authNoThrowMiddleware`, not `authMiddleware`.
   */
  describe("public browsing without a session", () => {
    it("lists published listings to an anonymous caller", async () => {
      const response = await call("GET", "/v1/store/listings?limit=100", null)
      expect(response.status).toBe(200)

      const data = response.json.data as { slug: string; tags: string[] }[]
      expect(data.map((row) => row.slug)).toContain(publishedSlug)
      expect(data.map((row) => row.slug)).toContain("linkding")
    })

    it("reads one listing with its tags, screenshots, and README, anonymously", async () => {
      const response = await call("GET", `/v1/store/listings/${publishedSlug}`, null)
      expect(response.status).toBe(200)
      expect(response.json.readmeMd).toContain("Sprout Widget Kit")
      expect(response.json.tags).toStrictEqual(["storetest-widgets"])

      const screenshots = response.json.screenshots as { url: string }[]
      expect(screenshots).toHaveLength(1)
      expect(screenshots[0].url).toBe("https://cdn.example.com/shot.png")
    })

    it("serves the categories and tag facets anonymously", async () => {
      const categories = await call("GET", "/v1/store/categories", null)
      expect(categories.status).toBe(200)
      expect((categories.json.data as unknown[]).length).toBeGreaterThan(0)

      const tags = await call("GET", "/v1/store/tags", null)
      expect(tags.status).toBe(200)
      expect(tags.json.data).toContain("storetest-widgets")
    })

    it("records a view event with no user attached", async () => {
      const response = await call("POST", `/v1/store/listings/${publishedSlug}/events`, null, {
        kind: "view",
      })
      expect(response.status).toBe(200)

      const event = await db
        .selectFrom("storeListingEvent")
        .select(["kind", "userId"])
        .where("storeListingId", "=", publishedId)
        .executeTakeFirstOrThrow()

      expect(event.kind).toBe("view")
      expect(event.userId).toBeNull()
    })

    /**
     * Community submissions are untrusted markdown. An unpublished body has not been reviewed, so
     * it is not merely hidden from the list — it is unreachable by slug as well.
     */
    it("hides an unpublished listing from both the list and the detail route", async () => {
      const list = await call("GET", "/v1/store/listings?limit=100", null)
      const slugs = (list.json.data as { slug: string }[]).map((row) => row.slug)
      expect(slugs).not.toContain(draftSlug)

      const detail = await call("GET", `/v1/store/listings/${draftSlug}`, null)
      expect(detail.status).toBe(404)
    })

    it("keeps an unpublished listing out of the tag facet even when it carries the tag", async () => {
      const list = await call("GET", "/v1/store/listings?tag=storetest-widgets", null)
      const slugs = (list.json.data as { slug: string }[]).map((row) => row.slug)
      expect(slugs).toStrictEqual([publishedSlug])
    })
  })

  describe("the featured rail", () => {
    /**
     * Ranked ordering is served whole rather than paginated: the shared cursor anchors on a UUID
     * and pairs it with `WHERE id < anchor`, which describes nothing once rows are ordered by
     * editorial rank.
     */
    it("returns ranked listings with no cursor at all", async () => {
      const response = await call("GET", "/v1/store/featured", null)
      expect(response.status).toBe(200)
      expect(response.json.nextCursor).toBeUndefined()

      const data = response.json.data as { slug: string; featuredRank: number | null }[]
      expect(data.length).toBeGreaterThan(0)

      const ranks = data.map((row) => row.featuredRank)
      const ranked = ranks.filter((rank) => rank !== null)
      expect(ranked).toStrictEqual([...ranked].sort((a, b) => a - b))
      expect(ranks.indexOf(null)).toBe(ranked.length === ranks.length ? -1 : ranked.length)
    })

    it("keeps unpublished listings out of the rail", async () => {
      const response = await call("GET", "/v1/store/featured", null)
      const slugs = (response.json.data as { slug: string }[]).map((row) => row.slug)
      expect(slugs).not.toContain(draftSlug)
    })
  })

  describe("search and filters", () => {
    it("matches the full-text index on a term from the description", async () => {
      const response = await call("GET", "/v1/store/listings?q=zorblatt", null)
      expect(response.status).toBe(200)

      const data = response.json.data as { slug: string }[]
      expect(data.map((row) => row.slug)).toStrictEqual([publishedSlug])
    })

    it("filters by category slug and rejects one that does not exist", async () => {
      const categories = await call("GET", "/v1/store/categories", null)
      const first = (categories.json.data as { slug: string }[])[0]

      const ok = await call("GET", `/v1/store/listings?category=${first.slug}`, null)
      expect(ok.status).toBe(200)

      const bad = await call("GET", "/v1/store/listings?category=no-such-category", null)
      expect(bad.status).toBe(400)
    })

    /**
     * TASK 18 defers every runtime but `web`. The facet still accepts the deferred values, so a
     * client asking for `android` gets an empty page rather than a 400 — and the filter does not
     * change shape when a runtime lands.
     */
    it("filters by platform, including the ones nothing implements yet", async () => {
      const web = await call("GET", "/v1/store/listings?platform=web&limit=100", null)
      expect(web.status).toBe(200)
      expect((web.json.data as { slug: string }[]).map((row) => row.slug)).toContain(publishedSlug)

      const android = await call("GET", "/v1/store/listings?platform=android", null)
      expect(android.status).toBe(200)
      expect(android.json.data).toStrictEqual([])
    })

    it("rejects an unknown platform outright", async () => {
      const response = await call("GET", "/v1/store/listings?platform=haiku", null)
      expect(response.status).toBe(400)
    })

    it("paginates and refuses a malformed cursor", async () => {
      const first = await call("GET", "/v1/store/listings?limit=2", null)
      expect(first.status).toBe(200)
      expect((first.json.data as unknown[]).length).toBe(2)

      const cursor = first.json.nextCursor as string
      expect(cursor).not.toBeNull()

      const second = await call(
        "GET",
        `/v1/store/listings?limit=2&cursor=${encodeURIComponent(cursor)}`,
        null,
      )
      expect(second.status).toBe(200)

      const firstSlugs = new Set((first.json.data as { slug: string }[]).map((row) => row.slug))
      const secondSlugs = (second.json.data as { slug: string }[]).map((row) => row.slug)
      expect(secondSlugs.some((entry) => firstSlugs.has(entry))).toBe(false)

      const bad = await call("GET", "/v1/store/listings?cursor=not-a-cursor", null)
      expect(bad.status).toBe(400)
    })
  })

  describe("moderation", () => {
    it("requires a session at all", async () => {
      const response = await call("GET", `/v1/orgs/${slug}/store/listings`, null)
      expect(response.status).toBe(401)
    })

    /**
     * 404 rather than 403 for a non-member, the same as every other org-scoped route: a 403 would
     * confirm the slug names a real team.
     */
    it("hides the moderation queue from someone outside the organization", async () => {
      const response = await call("GET", `/v1/orgs/${slug}/store/listings`, stranger)
      expect(response.status).toBe(404)
    })

    it("shows unpublished listings to a moderator", async () => {
      const response = await call(
        "GET",
        `/v1/orgs/${slug}/store/listings?status=draft&limit=100`,
        moderator,
      )
      expect(response.status).toBe(200)

      const slugs = (response.json.data as { slug: string }[]).map((row) => row.slug)
      expect(slugs).toContain(draftSlug)
    })

    it("publishes a draft, records the reviewer, and audits it", async () => {
      const response = await call(
        "POST",
        `/v1/orgs/${slug}/store/listings/${draftId}/publish`,
        moderator,
      )
      expect(response.status).toBe(200)
      expect(response.json.status).toBe("published")
      expect(response.json.reviewedByUserId).toBe(moderator.id)
      expect(response.json.reviewedAt).not.toBeNull()

      const audit = await db
        .selectFrom("auditLog")
        .select(["action", "resourceSrn"])
        .where("organizationId", "=", organizationId)
        .where("action", "=", "store:listing:publish")
        .executeTakeFirst()

      expect(audit?.resourceSrn).toContain(draftId)

      const anonymous = await call("GET", `/v1/store/listings/${draftSlug}`, null)
      expect(anonymous.status).toBe(200)
    })

    it("unpublishes with a reason and removes it from the public catalogue again", async () => {
      const response = await call(
        "POST",
        `/v1/orgs/${slug}/store/listings/${draftId}/unpublish`,
        moderator,
        { status: "rejected", reason: "Upstream repository was archived" },
      )
      expect(response.status).toBe(200)
      expect(response.json.status).toBe("rejected")
      expect(response.json.rejectionReason).toBe("Upstream repository was archived")

      const anonymous = await call("GET", `/v1/store/listings/${draftSlug}`, null)
      expect(anonymous.status).toBe(404)
    })

    it("404s a listing id that does not exist", async () => {
      const response = await call(
        "POST",
        `/v1/orgs/${slug}/store/listings/${v7()}/publish`,
        moderator,
      )
      expect(response.status).toBe(404)
    })
  })
})
