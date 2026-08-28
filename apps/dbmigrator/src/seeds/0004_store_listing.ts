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
  /**
   * Where this application's Dockerfile is, relative to `rootDir`.
   *
   * Required, with no default, on purpose. The builder used to assume `Dockerfile` at the
   * repository root, and of the six applications originally listed here **two** kept one there —
   * the other four forked, built, and died on `failed to read dockerfile`. A store of forkable
   * applications whose entries cannot be deployed is not a store, and a field that could be
   * omitted is a field that would be.
   */
  rootDir: string
  dockerfilePath: string
  /**
   * The upstream's default branch, which is not always `main`.
   *
   * It was hardcoded to `main` for every listing, and it is what the fork's production branch and
   * the first deploy's ref are both taken from. WriteFreely's is `develop`; a listing seeded with
   * `main` would fork correctly and then deploy a branch that does not exist.
   *
   * That fix corrected WriteFreely and stopped. Checking all six against the GitHub API afterwards
   * found **linkding and Shiori still on `master`** — two of six listings carrying exactly the
   * defect this comment describes, under a comment saying it had been dealt with. Both are
   * corrected here, and every value is now one the API was asked for rather than one that looked
   * right.
   */
  defaultBranch: string
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
    rootDir: ".",
    // `docker/alpine.Dockerfile` is the other one; the default is the glibc build.
    dockerfilePath: "docker/default.Dockerfile",
    // `master`. Verified against the API, not assumed — see the note on this field.
    defaultBranch: "master",
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
    rootDir: ".",
    dockerfilePath: "scripts/Dockerfile",
    defaultBranch: "main",
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
    rootDir: ".",
    dockerfilePath: "Dockerfile",
    // `master`. Verified against the API, not assumed — see the note on this field.
    defaultBranch: "master",
  },
  {
    slug: "twenty",
    name: "Twenty",
    tagline: "An open-source CRM that does not bill per seat to stay usable.",
    descriptionMd:
      "Fork Twenty when you want a CRM your team can shape instead of renting a fixed workflow. " +
      "Start with contacts, companies, opportunities, pipelines, APIs, and webhooks, then use your " +
      "own repository to change the product and keep control of its data.",
    categorySlug: "productivity",
    upstreamOwner: "twentyhq",
    upstreamRepo: "twenty",
    homepageUrl: "https://twenty.com",
    /*
      Not an SPDX identifier, and not recorded as one.

      Twenty ships its own licence — AGPL for the core with a separate enterprise edition — and
      GitHub reports it as `NOASSERTION`. Writing `AGPL-3.0` here to satisfy the field's shape would
      state something about a customer's obligations that is not true, so it says what it is.
    */
    licenseSpdx: "LicenseRef-Twenty",
    tags: ["crm", "sales", "typescript"],
    rootDir: ".",
    // A monorepo: the deployable image is assembled under `packages/twenty-docker`, not at the root.
    dockerfilePath: "packages/twenty-docker/twenty/Dockerfile",
    defaultBranch: "main",
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
    rootDir: ".",
    dockerfilePath: "Dockerfile",
    defaultBranch: "main",
  },
  {
    slug: "glance",
    name: "Glance",
    tagline: "One dashboard for every feed, calendar, and server you watch.",
    descriptionMd:
      "Widgets for RSS, GitHub releases, weather, Docker, and monitoring, arranged in columns " +
      "you configure in one YAML file.",
    categorySlug: "productivity",
    upstreamOwner: "glanceapp",
    upstreamRepo: "glance",
    homepageUrl: null,
    licenseSpdx: "AGPL-3.0-only",
    tags: ["dashboard", "feeds", "go"],
    rootDir: ".",
    dockerfilePath: "Dockerfile",
    defaultBranch: "main",
  },
  {
    slug: "writefreely",
    name: "WriteFreely",
    tagline: "A writing-first blog with no dashboard to get lost in.",
    descriptionMd:
      "Markdown in, a clean page out, and ActivityPub if you want the posts to federate. One " +
      "binary and a database.",
    categorySlug: "publishing",
    upstreamOwner: "writefreely",
    upstreamRepo: "writefreely",
    homepageUrl: "https://writefreely.org",
    licenseSpdx: "AGPL-3.0-only",
    tags: ["blog", "writing", "activitypub"],
    rootDir: ".",
    dockerfilePath: "Dockerfile",
    defaultBranch: "develop",
  },
]

/**
 * Listings this file used to carry and no longer does.
 *
 * `mattermost/focalboard` is archived upstream and has no Dockerfile at its final commit;
 * `withastro/astro` is the framework's monorepo, listed as "Astro Blog Starter", and has no
 * deployable image anywhere in it. Both forked cleanly and then failed at the build, which is the
 * worst place for a catalogue to be wrong: after the customer has a repository.
 *
 * Withdrawn rather than deleted. `project.store_listing_id` points at them from any project already
 * forked, `usage_event` is downstream of that, and a listing nobody can fork is exactly what
 * `status` is for.
 */
const WITHDRAWN = ["focalboard", "astro-blog-starter"] as const

/** From `store_listing_status_check`. Asserted against `pg_constraint` in the seed's test. */
export const LISTING_ARCHIVED = "archived"

export async function seed(db: Kysely<any>): Promise<void> {
  const categories = asRows(await db.selectFrom("store_category").select(["id", "slug"]).execute())
  const categoryIdBySlug = new Map<string, string>(
    categories.map((row: Row) => [text(row, "slug"), text(row, "id")]),
  )

  await db
    .updateTable("store_listing")
    // `archived`, checked against `store_listing_status_check` rather than chosen. The natural word
    // for this is "withdrawn" and the constraint does not have it — draft, pending_review,
    // published, rejected, archived.
    .set({ status: LISTING_ARCHIVED })
    .where("slug", "in", [...WITHDRAWN])
    .where("status", "=", "published")
    .execute()

  for (const listing of LISTINGS) {
    const existing = asRow(
      await db
        .selectFrom("store_listing")
        .select(["id"])
        .where("slug", "=", listing.slug)
        .executeTakeFirst(),
    )

    /*
      An existing listing is reconciled, not skipped.

      The original wrote `continue` here, which makes the seed create-only: a corrected value never
      reaches a deployment that already ran it. That is how four listings kept a `dockerfile_path`
      of `Dockerfile` after the correct paths were known — the seed had them and had no way to say
      so. Everything reconciled below is catalogue metadata that only this file owns; nothing a
      customer or a moderator can edit is touched.
    */
    if (existing) {
      await db
        .updateTable("store_listing")
        .set({
          name: listing.name,
          tagline: listing.tagline,
          description_md: listing.descriptionMd,
          homepage_url: listing.homepageUrl,
          root_dir: listing.rootDir,
          dockerfile_path: listing.dockerfilePath,
          default_branch: listing.defaultBranch,
          upstream_owner: listing.upstreamOwner,
          upstream_repo: listing.upstreamRepo,
          upstream_repo_url: `https://github.com/${listing.upstreamOwner}/${listing.upstreamRepo}`,
          deployment_source_owner: "SproutOS-Apps",
          deployment_source_repo: listing.upstreamRepo,
          deployment_instructions_path: "SPROUT_OS_DEPLOY.md",
        })
        .where("id", "=", text(existing, "id"))
        .execute()
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
        deployment_source_owner: "SproutOS-Apps",
        deployment_source_repo: listing.upstreamRepo,
        deployment_instructions_path: "SPROUT_OS_DEPLOY.md",
        homepage_url: listing.homepageUrl,
        root_dir: listing.rootDir,
        dockerfile_path: listing.dockerfilePath,
        default_branch: listing.defaultBranch,
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
