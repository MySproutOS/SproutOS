import type { DB } from "@sproutos/db"
import { type Kysely, type Selectable, sql } from "kysely"

/** The listing statuses a visitor may ever see. Everything else is moderation-only. */
export const PUBLIC_LISTING_STATUS = "published"

export type StoreListingFilters = {
  q?: string | null
  categoryId?: string | null
  tag?: string | null
  platform?: string | null
  status?: string | null
}

const LIST_FIELDS = [
  "storeListing.id as id",
  "storeListing.slug as slug",
  "storeListing.name as name",
  "storeListing.tagline as tagline",
  "storeListing.platform as platform",
  "storeListing.status as status",
  "storeListing.categoryId as categoryId",
  "storeListing.licenseSpdx as licenseSpdx",
  "storeListing.upstreamOwner as upstreamOwner",
  "storeListing.upstreamRepo as upstreamRepo",
  "storeListing.upstreamRepoUrl as upstreamRepoUrl",
  "storeListing.homepageUrl as homepageUrl",
  "storeListing.starsCount as starsCount",
  "storeListing.forksCount as forksCount",
  "storeListing.installCount as installCount",
  "storeListing.featuredRank as featuredRank",
  "storeListing.createdAt as createdAt",
] as const

/**
 * Card queries return `categoryId` and stop there.
 *
 * `store_category` is five rows; a caller rendering a page resolves the names once with
 * `fetchStoreCategory(db).listAll()` and maps locally. Joining it into the builder would be one
 * fewer query and one much worse type: Kysely's `leftJoin` maps over every table in `DB`, and the
 * resulting inferred factory type can no longer be named under `declaration: true` (TS2883).
 * `getPublishedDetail` can join because its return type is written out by hand.
 */

/**
 * The detail columns, plus the joined category. One query, because the page that renders this is
 * server-side and every extra round trip is on the visitor's critical path.
 */
export type StoreListingDetail = {
  id: string
  slug: string
  name: string
  tagline: string
  descriptionMd: string
  readmeMd: string | null
  platform: string
  status: string
  categoryId: string | null
  categorySlug: string | null
  categoryName: string | null
  licenseSpdx: string | null
  defaultBranch: string
  upstreamHost: string
  upstreamOwner: string
  upstreamRepo: string
  upstreamRepoUrl: string
  homepageUrl: string | null
  starsCount: number
  forksCount: number
  installCount: number
  featuredRank: number | null
  upstreamPushedAt: Date | null
  lastSyncedAt: Date | null
  createdAt: Date
}

/**
 * Reads of `store_listing` filter `deleted_at IS NULL` by default, per ADR 0017.
 *
 * They also filter on status, and that predicate is not optional in the public path: an
 * unpublished listing carries community-submitted markdown that has not been reviewed, and the
 * store notes are explicit that unreviewed bodies are never rendered. `browseQuery` therefore
 * takes the status as an argument rather than defaulting to "any", so a caller that forgets it
 * gets a type error rather than a moderation queue served to the internet.
 */
export function fetchStoreListing(db: Kysely<DB>) {
  function browseQuery(filters: StoreListingFilters) {
    const status = filters.status ?? PUBLIC_LISTING_STATUS
    const search = filters.q?.trim()

    return db
      .selectFrom("storeListing")
      .where("storeListing.deletedAt", "is", null)
      .where("storeListing.status", "=", status)
      .$if(status === PUBLIC_LISTING_STATUS, (qb) =>
        qb.where("storeListing.deploymentInstructionsPath", "is not", null),
      )
      .$if(!!filters.categoryId, (qb) =>
        qb.where("storeListing.categoryId", "=", filters.categoryId!),
      )
      .$if(!!filters.platform, (qb) => qb.where("storeListing.platform", "=", filters.platform!))
      .$if(!!filters.tag, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom("storeListingTag")
              .select("storeListingTag.id")
              .whereRef("storeListingTag.storeListingId", "=", "storeListing.id")
              .where("storeListingTag.tag", "=", filters.tag!),
          ),
        ),
      )
      .$if(!!search, (qb) =>
        qb.where(
          sql<boolean>`store_listing.search_vector @@ websearch_to_tsquery('english', ${search})`,
        ),
      )
      .select([...LIST_FIELDS])
      .orderBy("storeListing.id", "desc")
  }

  /**
   * The featured rail: `featured_rank` first, then stars.
   *
   * Deliberately capped and unpaginated. A ranked ordering cannot be cursor-paginated by
   * `utils/pagination.ts`, whose cursor carries a UUID anchor and pairs it with `WHERE id <
   * anchor` — a predicate that means nothing once the rows are ordered by rank. The catalogue
   * query above is therefore ordered by id (UUIDv7, so newest first), which the anchor does
   * describe, and ranking lives here where the whole result fits in one response.
   */
  function featuredQuery(limit: number) {
    return db
      .selectFrom("storeListing")
      .where("storeListing.deletedAt", "is", null)
      .where("storeListing.status", "=", PUBLIC_LISTING_STATUS)
      .where("storeListing.deploymentInstructionsPath", "is not", null)
      .select([...LIST_FIELDS])
      .orderBy(sql`store_listing.featured_rank nulls last`)
      .orderBy("storeListing.starsCount", "desc")
      .orderBy("storeListing.id", "desc")
      .limit(limit)
  }

  async function getBySlug<T extends (keyof DB["storeListing"])[]>(
    slug: string,
    fields: T,
    status: string | null = PUBLIC_LISTING_STATUS,
  ): Promise<Pick<Selectable<DB["storeListing"]>, T[number]> | undefined> {
    return await db
      .selectFrom("storeListing")
      .select(fields)
      .where("slug", "=", slug)
      .where("deletedAt", "is", null)
      .$if(status !== null, (qb) => qb.where("status", "=", status!))
      .executeTakeFirst()
  }

  /**
   * One published listing with its category, for the detail page.
   *
   * Fixed column set rather than the generic `fields` pattern, because the category columns come
   * from a join and `keyof DB["storeListing"]` cannot name them. `getBySlug` remains available for
   * callers that want to choose their own columns off the listing table alone.
   */
  async function getPublishedDetail(slug: string): Promise<StoreListingDetail | undefined> {
    return await db
      .selectFrom("storeListing")
      .leftJoin("storeCategory", "storeCategory.id", "storeListing.categoryId")
      .select([
        "storeListing.id as id",
        "storeListing.slug as slug",
        "storeListing.name as name",
        "storeListing.tagline as tagline",
        "storeListing.descriptionMd as descriptionMd",
        "storeListing.readmeMd as readmeMd",
        "storeListing.platform as platform",
        "storeListing.status as status",
        "storeListing.categoryId as categoryId",
        "storeCategory.slug as categorySlug",
        "storeCategory.name as categoryName",
        "storeListing.licenseSpdx as licenseSpdx",
        "storeListing.defaultBranch as defaultBranch",
        "storeListing.upstreamHost as upstreamHost",
        "storeListing.upstreamOwner as upstreamOwner",
        "storeListing.upstreamRepo as upstreamRepo",
        "storeListing.upstreamRepoUrl as upstreamRepoUrl",
        "storeListing.homepageUrl as homepageUrl",
        "storeListing.starsCount as starsCount",
        "storeListing.forksCount as forksCount",
        "storeListing.installCount as installCount",
        "storeListing.featuredRank as featuredRank",
        "storeListing.upstreamPushedAt as upstreamPushedAt",
        "storeListing.lastSyncedAt as lastSyncedAt",
        "storeListing.createdAt as createdAt",
      ])
      .where("storeListing.slug", "=", slug)
      .where("storeListing.deletedAt", "is", null)
      .where("storeListing.status", "=", PUBLIC_LISTING_STATUS)
      .where("storeListing.deploymentInstructionsPath", "is not", null)
      .executeTakeFirst()
  }

  async function getOne<T extends (keyof DB["storeListing"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["storeListing"]>, T[number]> | undefined> {
    return await db
      .selectFrom("storeListing")
      .select(fields)
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  return { browseQuery, featuredQuery, getBySlug, getOne, getPublishedDetail }
}
