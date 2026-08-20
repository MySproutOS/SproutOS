// Each listing's tags depend on the listing insert that precedes them, so the writes stay serial.
/* oxlint-disable no-await-in-loop */
import type { Kysely } from "kysely"
import { type Row, asRow, asRows, text } from "../lib/rows"
import { uuidV7 } from "../lib/uuid"

type Listing = {
  slug: string
  name: string
  tagline: string
  descriptionMd: string
  categorySlug: string
  upstreamOwner: string
  upstreamRepo: string
  homepageUrl: string | null
  licenseSpdx: string
  tags: string[]
}

const LISTINGS: Listing[] = [
  {
    slug: "linkding",
    name: "linkding",
    tagline: "A fast, minimal bookmark manager you can actually self-host.",
    descriptionMd:
      "Tag-based bookmarking with full-text search, a bookmarklet, and a browser extension. " +
      "Small enough to run on the cheapest instance SproutOS offers.",
    categorySlug: "personal-tools",
    upstreamOwner: "sissbruecker",
    upstreamRepo: "linkding",
    homepageUrl: null,
    licenseSpdx: "MIT",
    tags: ["bookmarks", "search", "django"],
  },
  {
    slug: "memos",
    name: "Memos",
    tagline: "A lightweight note-taking service with a public sharing mode.",
    descriptionMd:
      "Plain-text-first notes with markdown, tags, and optional public pages. " +
      "Good first fork if you want a personal microblog.",
    categorySlug: "personal-tools",
    upstreamOwner: "usememos",
    upstreamRepo: "memos",
    homepageUrl: "https://www.usememos.com",
    licenseSpdx: "MIT",
    tags: ["notes", "markdown", "go"],
  },
  {
    slug: "shiori",
    name: "Shiori",
    tagline: "Save pages for later and keep a readable archive of them.",
    descriptionMd:
      "A read-later service that stores an offline copy of every page, so a dead link is still " +
      "readable a year later.",
    categorySlug: "personal-tools",
    upstreamOwner: "go-shiori",
    upstreamRepo: "shiori",
    homepageUrl: null,
    licenseSpdx: "MIT",
    tags: ["read-later", "archive", "go"],
  },
  {
    slug: "vikunja",
    name: "Vikunja",
    tagline: "Task tracking with lists, kanban, and Gantt in one place.",
    descriptionMd:
      "Projects, labels, reminders, and shared teams. The API is first-class, so it doubles as a " +
      "backend for your own task UI.",
    categorySlug: "productivity",
    upstreamOwner: "go-vikunja",
    upstreamRepo: "vikunja",
    homepageUrl: "https://vikunja.io",
    licenseSpdx: "AGPL-3.0-only",
    tags: ["tasks", "kanban", "teams"],
  },
  {
    slug: "focalboard",
    name: "Focalboard",
    tagline: "Project boards for teams that want their data in their own database.",
    descriptionMd:
      "Board, table, and calendar views over the same cards. Forks cleanly and deploys as a " +
      "single service.",
    categorySlug: "productivity",
    upstreamOwner: "mattermost",
    upstreamRepo: "focalboard",
    homepageUrl: null,
    licenseSpdx: "MIT",
    tags: ["boards", "planning", "teams"],
  },
  {
    slug: "astro-blog-starter",
    name: "Astro Blog Starter",
    tagline: "A content-first blog that builds to static files and costs almost nothing to run.",
    descriptionMd:
      "Markdown and MDX posts, RSS, sitemap, and typed content collections. The cheapest thing " +
      "in the catalogue to keep online.",
    categorySlug: "publishing",
    upstreamOwner: "withastro",
    upstreamRepo: "astro",
    homepageUrl: "https://astro.build",
    licenseSpdx: "MIT",
    tags: ["blog", "static", "astro"],
  },
]

export async function seed(db: Kysely<any>): Promise<void> {
  const categories = asRows(await db.selectFrom("store_category").select(["id", "slug"]).execute())
  const categoryIdBySlug = new Map<string, string>(
    categories.map((row: Row) => [text(row, "slug"), text(row, "id")]),
  )

  for (const listing of LISTINGS) {
    const existing = asRow(
      await db
        .selectFrom("store_listing")
        .select(["id"])
        .where("slug", "=", listing.slug)
        .executeTakeFirst(),
    )

    if (existing) {
      continue
    }

    const id = uuidV7()

    await db
      .insertInto("store_listing")
      .values({
        id,
        slug: listing.slug,
        name: listing.name,
        tagline: listing.tagline,
        description_md: listing.descriptionMd,
        upstream_host: "github.com",
        upstream_owner: listing.upstreamOwner,
        upstream_repo: listing.upstreamRepo,
        upstream_repo_url: `https://github.com/${listing.upstreamOwner}/${listing.upstreamRepo}`,
        homepage_url: listing.homepageUrl,
        default_branch: "main",
        license_spdx: listing.licenseSpdx,
        platform: "web",
        category_id: categoryIdBySlug.get(listing.categorySlug) ?? null,
        status: "published",
      })
      .execute()

    await db
      .insertInto("store_listing_tag")
      .values(listing.tags.map((tag) => ({ id: uuidV7(), store_listing_id: id, tag })))
      .onConflict((oc) => oc.columns(["store_listing_id", "tag"]).doNothing())
      .execute()
  }
}
