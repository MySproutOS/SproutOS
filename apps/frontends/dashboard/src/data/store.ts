import { useQuery } from "@tanstack/react-query"
import {
  getV1StoreListingsBySlugOptions,
  getV1StoreListingsOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type StoreListing = {
  slug: string
  name: string
  glyph: string
  tagline: string
  author: string
  installs: string
  /**
   * Null when nobody has estimated it.
   *
   * Not `0n`: zero renders as `$0.00`, which tells a customer this is free to run. Estimating it
   * would mean guessing how much compute a project a stranger wrote will use, and a number someone
   * plans around has to come from a curator's declared figure or the metered cost of existing
   * forks. Neither exists yet, and a plausible invented one is worse than an honest absence.
   */
  estimatedMonthlyCostMicros: bigint | null
  tags: string[]
}

export type StoreListingDetail = StoreListing & {
  description: string
  repo: string
  version: string
  requires: string[]
}

const INSTALLS = new Intl.NumberFormat("en-US")

/**
 * The listing's letter, not an emoji.
 *
 * `store_listing` has no glyph column and nothing lets a curator pick one, so deriving an emoji
 * from the slug would be inventing a choice nobody made. The initial is the same treatment the
 * project list and the team switcher use.
 */
function glyphFor(name: string): string {
  return (name.trim()[0] ?? "·").toUpperCase()
}

/** See `StoreListing.estimatedMonthlyCostMicros`. */
const UNKNOWN_MONTHLY_COST = null

export function useStoreListings() {
  const query = useQuery(getV1StoreListingsOptions())

  return {
    ...query,
    data: query.data?.data.map((listing): StoreListing => ({
      slug: listing.slug,
      name: listing.name,
      glyph: glyphFor(listing.name),
      tagline: listing.tagline,
      author: listing.upstreamOwner,
      installs: INSTALLS.format(listing.installCount),
      estimatedMonthlyCostMicros: UNKNOWN_MONTHLY_COST,
      tags: listing.tags,
    })),
  }
}

export function useStoreListing(slug: string) {
  const query = useQuery(getV1StoreListingsBySlugOptions({ path: { slug } }))
  const listing = query.data

  return {
    ...query,
    data:
      listing === undefined
        ? undefined
        : ({
            slug: listing.slug,
            name: listing.name,
            glyph: glyphFor(listing.name),
            tagline: listing.tagline,
            author: listing.upstreamOwner,
            installs: INSTALLS.format(listing.installCount),
            estimatedMonthlyCostMicros: UNKNOWN_MONTHLY_COST,
            tags: listing.tags,
            description: listing.descriptionMd,
            repo: `${listing.upstreamOwner}/${listing.upstreamRepo}`,
            /*
              The branch, not a version.

              A listing tracks an upstream repository, and most of them do not publish releases —
              `store_listing` records `default_branch` and a last-synced time, which is genuinely
              what a fork would take. Showing "v1.4.2" would be a version number we made up.
            */
            version: listing.defaultBranch,
            /*
              What the project needs, as declared by its licence and platform.

              The *services* it needs come from TASKs 38/39's analyzer, whose manifest is stored on
              `repo_analysis` rather than on the listing — a listing that has never been analysed
              has nothing honest to say here.
            */
            requires: [listing.platform, listing.licenseSpdx].filter(
              (entry): entry is string => entry !== null && entry !== "",
            ),
          } satisfies StoreListingDetail),
  }
}
