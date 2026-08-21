import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/**
 * Every value `store_listing.platform` can hold.
 *
 * Only `web` has an implementation; the rest exist because ADR 0015 made the column an enum from
 * day one and TASK 18 defers the runtimes, not the vocabulary. They are filterable now so the
 * facet does not have to change shape when a runtime lands — and so a client asking for
 * `android` today gets an empty page rather than a 400.
 */
export const STORE_PLATFORMS = [
  "web",
  "android",
  "ios",
  "windows",
  "macos",
  "linux_debian",
] as const

const PlatformT = Type.Union(STORE_PLATFORMS.map((platform) => Type.Literal(platform)))

export const storeSchemaListQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 200 })),
  category: Type.Optional(Type.String({ maxLength: 64 })),
  tag: Type.Optional(Type.String({ maxLength: 64 })),
  platform: Type.Optional(PlatformT),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const storeSchemaSlugParam = Type.Object({
  slug: Type.String({ minLength: 3, maxLength: 63 }),
})

export const storeSchemaListingIdParam = Type.Object({
  orgSlug: Type.String({ minLength: 2, maxLength: 48 }),
  listingId: UUID7String,
})

const storeListingCard = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  name: Type.String(),
  tagline: Type.String(),
  platform: Type.String(),
  status: Type.String(),
  categoryId: Nullable(UUID7String),
  licenseSpdx: Nullable(Type.String()),
  upstreamOwner: Type.String(),
  upstreamRepo: Type.String(),
  upstreamRepoUrl: Type.String(),
  homepageUrl: Nullable(Type.String()),
  starsCount: Type.Number(),
  forksCount: Type.Number(),
  installCount: Type.Number(),
  /**
   * Micro-USD per month, as a string, or null when there is no honest estimate.
   *
   * A string because it is `bigint` on the way out and JSON has no integer wide enough to be
   * trusted with money. Null rather than `"0"` when too few forks exist to say anything — the
   * dashboard renders an em dash for null and `$0.00` for zero, and those mean opposite things to
   * somebody deciding whether they can afford to run this.
   */
  estimatedMonthlyCostMicroUsd: Nullable(Type.String()),
  /** How many live forks the estimate was computed from. Zero when there is no estimate. */
  estimateSampleSize: Type.Number(),
  featuredRank: Nullable(Type.Number()),
  createdAt: Type.String({ format: "date-time" }),
  tags: Type.Array(Type.String()),
})

export const storeSchemaListResponse = Type.Object({
  data: Type.Array(storeListingCard),
  nextCursor: Nullable(Type.String()),
})

export const storeSchemaFeaturedResponse = Type.Object({
  data: Type.Array(storeListingCard),
})

export const storeSchemaDetailResponse = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  name: Type.String(),
  tagline: Type.String(),
  descriptionMd: Type.String(),
  readmeMd: Nullable(Type.String()),
  platform: Type.String(),
  status: Type.String(),
  categoryId: Nullable(UUID7String),
  category: Nullable(
    Type.Object({
      id: UUID7String,
      slug: Type.String(),
      name: Type.String(),
    }),
  ),
  licenseSpdx: Nullable(Type.String()),
  defaultBranch: Type.String(),
  upstreamHost: Type.String(),
  upstreamOwner: Type.String(),
  upstreamRepo: Type.String(),
  upstreamRepoUrl: Type.String(),
  homepageUrl: Nullable(Type.String()),
  starsCount: Type.Number(),
  forksCount: Type.Number(),
  installCount: Type.Number(),
  /**
   * Micro-USD per month, as a string, or null when there is no honest estimate.
   *
   * A string because it is `bigint` on the way out and JSON has no integer wide enough to be
   * trusted with money. Null rather than `"0"` when too few forks exist to say anything — the
   * dashboard renders an em dash for null and `$0.00` for zero, and those mean opposite things to
   * somebody deciding whether they can afford to run this.
   */
  estimatedMonthlyCostMicroUsd: Nullable(Type.String()),
  /** How many live forks the estimate was computed from. Zero when there is no estimate. */
  estimateSampleSize: Type.Number(),
  featuredRank: Nullable(Type.Number()),
  upstreamPushedAt: Nullable(Type.String({ format: "date-time" })),
  lastSyncedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
  tags: Type.Array(Type.String()),
  screenshots: Type.Array(
    Type.Object({
      id: UUID7String,
      url: Type.String(),
      altText: Nullable(Type.String()),
      width: Nullable(Type.Number()),
      height: Nullable(Type.Number()),
      sortOrder: Type.Number(),
    }),
  ),
})

export const storeSchemaCategoriesResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      slug: Type.String(),
      name: Type.String(),
      description: Nullable(Type.String()),
      sortOrder: Type.Number(),
    }),
  ),
})

export const storeSchemaTagsResponse = Type.Object({
  data: Type.Array(Type.String()),
})

export const storeSchemaEventRequest = Type.Object({
  kind: Type.Union([Type.Literal("view"), Type.Literal("visit_upstream")]),
})

export const storeSchemaModerationQuery = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("pending_review"),
      Type.Literal("published"),
      Type.Literal("rejected"),
      Type.Literal("archived"),
    ]),
  ),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const storeSchemaUnpublishRequest = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("archived"), Type.Literal("rejected")])),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
})

export const storeSchemaModerationResponse = Type.Object({
  id: UUID7String,
  slug: Type.String(),
  status: Type.String(),
  reviewedByUserId: Nullable(UUID7String),
  reviewedAt: Nullable(Type.String({ format: "date-time" })),
  rejectionReason: Nullable(Type.String()),
})
