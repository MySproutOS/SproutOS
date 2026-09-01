import { fetchStoreListing } from "@lib/dao/storeListing/fetch"
import { db } from "@sproutos/db"
import { POSTS } from "@website/lib/blog"
import { DOCS } from "@website/lib/docs"
import type { MetadataRoute } from "next"

/**
 * The sitemap.
 *
 * Every URL here renders server-side for a visitor with no session — that is the whole point of the
 * `SHARED_ROUTES` and `NEXTJS_PUBLIC_PREFIXES` lists in `src/proxy.ts`, and a page listed here that
 * is not in one of them would offer a crawler a login redirect. Keep the two in step.
 *
 * `dynamic = "force-dynamic"` because the store listings come from the database: a sitemap frozen
 * at build time stops mentioning anything published afterwards.
 */
export const dynamic = "force-dynamic"

const STATIC_PATHS = [
  "/",
  "/personalize",
  "/data-ownership",
  "/data-ownership/developers",
  "/platform/databases",
  "/platform/workflows",
  "/platform/websites",
  "/platform/ai-agent",
  "/business/employees",
  "/business/it",
  "/store",
  "/download",
  "/blog",
  "/docs",
  "/docs/users",
  "/docs/developers",
  "/legal",
  "/legal/terms",
  "/legal/privacy",
  "/legal/conduct",
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const listings = await fetchStoreListing(db).browseQuery({}).execute()
  const now = new Date()

  return [
    ...STATIC_PATHS.map((path) => ({
      url: path,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: path === "/" ? 1 : 0.7,
    })),
    ...DOCS.map((doc) => ({
      url: `/docs/${doc.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
    ...POSTS.map((post) => ({
      url: `/blog/${post.slug}`,
      lastModified: new Date(post.date),
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
    ...listings.map((listing) => ({
      url: `/store/${listing.slug}`,
      lastModified: listing.createdAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ]
}
