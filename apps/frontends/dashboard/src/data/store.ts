import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugProjectsQueryKey,
  getV1StoreListingsBySlugOptions,
  getV1StoreListingsOptions,
  getV1StoreListingsQueryKey,
  postV1OrgsByOrgSlugProjectsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type StoreListing = {
  /**
   * The listing's UUID, not its slug.
   *
   * Carried because forking takes `source.storeListingId` — the slug is what a URL is keyed on and
   * what a curator may rename, and the fork has to name the row.
   */
  id: string
  slug: string
  name: string
  glyph: string
  tagline: string
  author: string
  installs: string
  /**
   * Null when there is no honest estimate yet.
   *
   * Not `0n`: zero renders as `$0.00`, which tells a customer this is free to run. This used to be
   * hardcoded null with a note saying an estimate "has to come from a curator's declared figure or
   * the metered cost of existing forks. Neither exists yet." The second one exists now — forks
   * carry `store_listing_id` and their usage is rolled up like anything else — so the API returns
   * the median monthly cost of live forks, and null below a floor of three, where a "typical cost"
   * would be one project's bill with a misleading label.
   */
  estimatedMonthlyCostMicros: bigint | null
  /** How many forks the estimate came from. Zero when there is none. */
  estimateSampleSize: number
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

/**
 * The API's string, as the bigint the renderer wants.
 *
 * A string on the wire because JSON has no integer wide enough to be trusted with money, and null
 * when there is no estimate — which is a different thing from `"0"` and renders differently.
 */
function monthlyCost(value: string | null): bigint | null {
  return value === null ? null : BigInt(value)
}

export function useStoreListings() {
  const query = useQuery(getV1StoreListingsOptions())

  return {
    ...query,
    data: query.data?.data.map((listing): StoreListing => ({
      id: listing.id,
      slug: listing.slug,
      name: listing.name,
      glyph: glyphFor(listing.name),
      tagline: listing.tagline,
      author: listing.upstreamOwner,
      installs: INSTALLS.format(listing.installCount),
      estimatedMonthlyCostMicros: monthlyCost(listing.estimatedMonthlyCostMicroUsd),
      estimateSampleSize: listing.estimateSampleSize,
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
            id: listing.id,
            slug: listing.slug,
            name: listing.name,
            glyph: glyphFor(listing.name),
            tagline: listing.tagline,
            author: listing.upstreamOwner,
            installs: INSTALLS.format(listing.installCount),
            estimatedMonthlyCostMicros: monthlyCost(listing.estimatedMonthlyCostMicroUsd),
            estimateSampleSize: listing.estimateSampleSize,
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

/**
 * Fork a store listing into a project.
 *
 * **This was the missing half of the store.** `POST /v1/orgs/:orgSlug/projects` has accepted
 * `source: { type: "store", … }` since the routes were written — it creates the repository, the
 * project and the provisioning job in one transaction. Nothing called it. The store's "Fork this
 * app" button was `<Button size="sm">Fork this app</Button>`: no handler, no request, no error. It
 * is the single action the product exists to perform, and clicking it did nothing at all, silently,
 * which is why no screenshot and no smoke test ever noticed.
 *
 * The idempotency key is generated per attempt rather than per click. A retry of the *same* attempt
 * must not create a second repository; a deliberate second fork of the same listing is a thing a
 * customer is allowed to do.
 */
export function useForkListing(orgSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    ...postV1OrgsByOrgSlugProjectsMutation(),
    onSuccess: () => {
      // The project list and the listing's install count both change. Invalidated rather than
      // written into the cache: the response carries the project, not the recomputed count.
      void queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsQueryKey({ path: { orgSlug } }),
      })
      void queryClient.invalidateQueries({ queryKey: getV1StoreListingsQueryKey() })
    },
  })
}
