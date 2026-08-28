import {
  crudAuditLog,
  crudStoreListing,
  crudStoreListingEvent,
  fetchStoreCategory,
  fetchStoreListing,
  fetchStoreListingScreenshot,
  fetchStoreListingTag,
} from "@lib/dao"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { authMiddleware, authNoThrowMiddleware } from "../middleware"
import { collectionResource, paramResource, requirePermission } from "../rbac"
import { estimateListingCosts } from "@lib/billing"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { cursorPaginate, decodeCursor } from "../utils/pagination"
import { auditContext } from "../utils/request-context"
import {
  storeSchemaCategoriesResponse,
  storeSchemaDetailResponse,
  storeSchemaEventRequest,
  storeSchemaFeaturedResponse,
  storeSchemaListingIdParam,
  storeSchemaListQuery,
  storeSchemaListResponse,
  storeSchemaModerationQuery,
  storeSchemaModerationResponse,
  storeSchemaSlugParam,
  storeSchemaTagsResponse,
  storeSchemaUnpublishRequest,
} from "./store.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * The estimate a card shows, in the shape the schema wants.
 *
 * One query for the whole page rather than one per card — the same reason `enrich` in `projects.ts`
 * batches. A listing with too few forks is absent from the map, and absent becomes `null`, which is
 * the em dash the dashboard already renders correctly.
 *
 * `NoActivePriceBookError` is deliberately not caught. A deployment with no price book seeded shows
 * every customer a free product, and the store is exactly where that lie would be most convincing.
 */
async function estimatesFor(
  listingIds: readonly string[],
): Promise<
  (id: string) => { estimatedMonthlyCostMicroUsd: string | null; estimateSampleSize: number }
> {
  const estimates = await estimateListingCosts(db, listingIds)

  return (id) => {
    const estimate = estimates.get(id)
    return estimate === undefined
      ? { estimatedMonthlyCostMicroUsd: null, estimateSampleSize: 0 }
      : {
          estimatedMonthlyCostMicroUsd: estimate.monthlyMicroUsd.toString(),
          estimateSampleSize: estimate.sampleSize,
        }
  }
}

/**
 * The public half of the store.
 *
 * `authNoThrowMiddleware`, not `authMiddleware`: TASK 4 requires the catalogue to be visible to
 * someone who has never signed in, and `apps/website/src/proxy.ts` renders `/store` as an SSR
 * page for exactly that visitor. A session, when there is one, is only used to attribute events.
 */
const app = new Hono()
  .use(authNoThrowMiddleware)
  .get(
    "/categories",
    describeRoute({
      description: "Lists the store categories",
      responses: {
        200: {
          description: "Categories, in display order",
          content: { "application/json": { schema: resolver(storeSchemaCategoriesResponse) } },
        },
      },
    }),
    async (c) => {
      const categories = await fetchStoreCategory(db).listAll([
        "id",
        "slug",
        "name",
        "description",
        "sortOrder",
      ])

      return c.json({ data: categories })
    },
  )
  .get(
    "/tags",
    describeRoute({
      description: "Lists the tags in use across published listings",
      responses: {
        200: {
          description: "Tags, alphabetically",
          content: { "application/json": { schema: resolver(storeSchemaTagsResponse) } },
        },
      },
    }),
    async (c) => {
      return c.json({ data: await fetchStoreListingTag(db).listDistinct(200) })
    },
  )
  .get(
    "/featured",
    describeRoute({
      description: "The featured rail, ranked by editorial rank and then by stars",
      responses: {
        200: {
          description: "Featured listings, highest rank first",
          content: { "application/json": { schema: resolver(storeSchemaFeaturedResponse) } },
        },
      },
    }),
    async (c) => {
      const results = await fetchStoreListing(db).featuredQuery(12).execute()
      const ids = results.map((row) => row.id)
      const [tags, estimate] = await Promise.all([
        fetchStoreListingTag(db).listForListings(ids),
        estimatesFor(ids),
      ])

      return c.json({
        data: results.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          tags: tags.get(row.id) ?? [],
          ...estimate(row.id),
        })),
      })
    },
  )
  .get(
    "/listings",
    describeRoute({
      description: "Browses and searches published store listings, newest first",
      responses: {
        200: {
          description: "A page of listings",
          content: { "application/json": { schema: resolver(storeSchemaListResponse) } },
        },
        400: { description: "Invalid cursor or unknown category", ...errorResponse },
      },
    }),
    validator("query", storeSchemaListQuery),
    async (c) => {
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null
      const limit = query.limit ?? 25

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      let categoryId: string | null = null
      if (query.category !== undefined) {
        const category = await fetchStoreCategory(db).getBySlug(query.category, ["id"])
        if (!category) return throwBadRequest(c, "Unknown category")
        categoryId = category.id
      }

      // Ordered by id, which is UUIDv7 and therefore newest first. The cursor in
      // `utils/pagination.ts` anchors on a UUID and pairs it with `WHERE id < anchor`, so this is
      // the only ordering it can page through correctly. Ranking lives on /store/featured.
      const { results, nextCursor } = await cursorPaginate({
        query: fetchStoreListing(db).browseQuery({
          q: query.q ?? null,
          categoryId,
          tag: query.tag ?? null,
          platform: query.platform ?? null,
        }),
        cursor,
        ordering: "id",
        positionColumn: "storeListing.id",
        pageSize: limit,
      })

      const ids = results.map((row) => row.id)
      const [tags, estimate] = await Promise.all([
        fetchStoreListingTag(db).listForListings(ids),
        estimatesFor(ids),
      ])

      return c.json({
        data: results.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          tags: tags.get(row.id) ?? [],
          ...estimate(row.id),
        })),
        nextCursor,
      })
    },
  )
  .get(
    "/listings/:slug",
    describeRoute({
      description: "Reads one published listing with its tags, screenshots, and README",
      responses: {
        200: {
          description: "The listing",
          content: { "application/json": { schema: resolver(storeSchemaDetailResponse) } },
        },
        404: { description: "No such published listing", ...errorResponse },
      },
    }),
    validator("param", storeSchemaSlugParam),
    async (c) => {
      const { slug } = c.req.valid("param")

      const listing = await fetchStoreListing(db).getPublishedDetail(slug)
      if (!listing) return throwNotFound(c, "Listing not found")

      const [tags, screenshots, estimate] = await Promise.all([
        fetchStoreListingTag(db).listForListing(listing.id),
        fetchStoreListingScreenshot(db).listForListing(listing.id, [
          "id",
          "url",
          "altText",
          "width",
          "height",
          "sortOrder",
        ]),
        estimatesFor([listing.id]),
      ])

      return c.json({
        ...listing,
        ...estimate(listing.id),
        category:
          listing.categoryId === null ||
          listing.categorySlug === null ||
          listing.categoryName === null
            ? null
            : { id: listing.categoryId, name: listing.categoryName, slug: listing.categorySlug },
        upstreamPushedAt: listing.upstreamPushedAt?.toISOString() ?? null,
        lastSyncedAt: listing.lastSyncedAt?.toISOString() ?? null,
        createdAt: listing.createdAt.toISOString(),
        screenshots,
        tags,
      })
    },
  )
  .post(
    "/listings/:slug/events",
    describeRoute({
      description: "Records a view or an outbound click on a listing",
      responses: {
        200: {
          description: "Event recorded",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        404: { description: "No such published listing", ...errorResponse },
      },
    }),
    validator("param", storeSchemaSlugParam),
    validator("json", storeSchemaEventRequest),
    async (c) => {
      const { slug } = c.req.valid("param")
      const json = c.req.valid("json")

      const listing = await fetchStoreListing(db).getBySlug(slug, ["id"])
      if (!listing) return throwNotFound(c, "Listing not found")

      await crudStoreListingEvent(db).record({
        storeListingId: listing.id,
        userId: c.var.user?.id ?? null,
        kind: json.kind,
      })

      return c.json({})
    },
  )

/**
 * Moderation, mounted under `/orgs/:orgSlug` rather than beside the public routes.
 *
 * The catalogue is global but `requirePermission` is not: it evaluates a grant inside one
 * organization and builds the SRN from the organization it resolved. Hanging these off
 * `/v1/store` would make them depend on `user_preference.last_org_id` to decide which team's
 * grants apply — a moderator in two organizations would get different answers depending on which
 * tab they last opened. The slug in the path makes the acting organization explicit, and it is
 * the organization the `audit_log` row is written against.
 */
export const storeModeration = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/store/listings",
    describeRoute({
      description: "Lists listings in any status, including unpublished submissions",
      responses: {
        200: {
          description: "A page of listings",
          content: { "application/json": { schema: resolver(storeSchemaListResponse) } },
        },
        403: { description: "Caller lacks store:listing:moderate", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("query", storeSchemaModerationQuery),
    requirePermission("store:listing:moderate", collectionResource("store", "listing")),
    async (c) => {
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null
      const limit = query.limit ?? 25

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const { results, nextCursor } = await cursorPaginate({
        query: fetchStoreListing(db).browseQuery({ status: query.status ?? "pending_review" }),
        cursor,
        ordering: "id",
        positionColumn: "storeListing.id",
        pageSize: limit,
      })

      const ids = results.map((row) => row.id)
      const [tags, estimate] = await Promise.all([
        fetchStoreListingTag(db).listForListings(ids),
        estimatesFor(ids),
      ])

      return c.json({
        data: results.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          tags: tags.get(row.id) ?? [],
          ...estimate(row.id),
        })),
        nextCursor,
      })
    },
  )
  .post(
    "/:orgSlug/store/listings/:listingId/publish",
    describeRoute({
      description: "Publishes a listing, making it visible to unauthenticated visitors",
      responses: {
        200: {
          description: "The published listing",
          content: { "application/json": { schema: resolver(storeSchemaModerationResponse) } },
        },
        403: { description: "Caller lacks store:listing:moderate", ...errorResponse },
        404: { description: "No such listing", ...errorResponse },
      },
    }),
    validator("param", storeSchemaListingIdParam),
    requirePermission("store:listing:moderate", paramResource("store", "listing", "listingId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { listingId } = c.req.valid("param")

      const before = await fetchStoreListing(db).getOne(listingId, ["id", "slug", "status"])
      if (!before) return throwNotFound(c, "Listing not found")

      const listing = await db.transaction().execute(async (tx) => {
        const row = await crudStoreListing(tx).publish(listingId, user.id)
        if (row === undefined) return undefined

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "store:listing:publish",
          resourceSrn: srnFor("store", organization.id, "listing", listingId),
          before: { status: before.status },
          after: { status: row.status, slug: row.slug },
          ...auditContext(c),
        })

        return row
      })

      if (listing === undefined) return throwNotFound(c, "Listing not found")

      return c.json({
        id: listing.id,
        slug: listing.slug,
        status: listing.status,
        reviewedByUserId: listing.reviewedByUserId,
        reviewedAt: listing.reviewedAt?.toISOString() ?? null,
        rejectionReason: listing.rejectionReason,
      })
    },
  )
  .post(
    "/:orgSlug/store/listings/:listingId/unpublish",
    describeRoute({
      description: "Takes a listing out of the public catalogue",
      responses: {
        200: {
          description: "The unpublished listing",
          content: { "application/json": { schema: resolver(storeSchemaModerationResponse) } },
        },
        403: { description: "Caller lacks store:listing:moderate", ...errorResponse },
        404: { description: "No such listing", ...errorResponse },
      },
    }),
    validator("param", storeSchemaListingIdParam),
    validator("json", storeSchemaUnpublishRequest),
    requirePermission("store:listing:moderate", paramResource("store", "listing", "listingId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { listingId } = c.req.valid("param")
      const json = c.req.valid("json")

      const before = await fetchStoreListing(db).getOne(listingId, ["id", "slug", "status"])
      if (!before) return throwNotFound(c, "Listing not found")

      // Unpublishing never deletes. ADR 0015 makes `project.store_listing_id`
      // `ON DELETE SET NULL` so that archiving is not blocked by the projects forked from a
      // listing, and those projects keep their provenance link as long as the row survives.
      const listing = await db.transaction().execute(async (tx) => {
        const row = await crudStoreListing(tx).unpublish(
          listingId,
          user.id,
          json.status ?? "archived",
          json.reason ?? null,
        )
        if (row === undefined) return undefined

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "store:listing:moderate",
          resourceSrn: srnFor("store", organization.id, "listing", listingId),
          before: { status: before.status },
          after: { status: row.status, rejectionReason: row.rejectionReason },
          ...auditContext(c),
        })

        return row
      })

      if (listing === undefined) return throwNotFound(c, "Listing not found")

      return c.json({
        id: listing.id,
        slug: listing.slug,
        status: listing.status,
        reviewedByUserId: listing.reviewedByUserId,
        reviewedAt: listing.reviewedAt?.toISOString() ?? null,
        rejectionReason: listing.rejectionReason,
      })
    },
  )

export default app
