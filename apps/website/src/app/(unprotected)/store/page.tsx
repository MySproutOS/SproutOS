import { fetchStoreCategory } from "@lib/dao/storeCategory/fetch"
import { fetchStoreListing } from "@lib/dao/storeListing/fetch"
import { fetchStoreListingTag } from "@lib/dao/storeListingTag/fetch"
import { db } from "@sproutos/db"
import type { Metadata } from "next"
import Link from "next/link"
import { Nav } from "../_components/landing/nav"
import { SiteFooter } from "../_components/landing/site-footer"
import { ListingCard } from "./_components/listing-card"
import { StoreFilters } from "./_components/store-filters"
import { isFiltered, parseStoreQuery, storeHref, type StoreQuery } from "./query"

export const metadata: Metadata = {
  title: "App store — SproutOS",
  description:
    "Open source apps that already work, ready to fork into your own account. Pick one, describe " +
    "the change you want, and it becomes yours — running on your own database.",
}

const PAGE_SIZE = 24
const FEATURED = 3
const TAG_CLOUD = 18

export default async function StorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = parseStoreQuery(await searchParams)

  const listings = fetchStoreListing(db)
  const categories = await fetchStoreCategory(db).listAll(["id", "slug", "name"])

  // The URL carries a category *slug*, which is what a person can read and link to; the query
  // filters on the id. An unknown slug filters on an id nothing matches, which renders the empty
  // state — the honest answer for a category that does not exist.
  const categoryId =
    query.category === null
      ? null
      : (categories.find((c) => c.slug === query.category)?.id ??
        "00000000-0000-0000-0000-000000000000")

  const rows = await listings
    .browseQuery({ q: query.q, categoryId, tag: query.tag })
    // Fetch one more than the page to learn whether there is a next one without a count query.
    .$if(query.cursor !== null, (qb) => qb.where("storeListing.id", "<", query.cursor!))
    .limit(PAGE_SIZE + 1)
    .execute()

  const hasNext = rows.length > PAGE_SIZE
  const page = hasNext ? rows.slice(0, PAGE_SIZE) : rows

  const [tagsByListing, tagCloud, featured] = await Promise.all([
    fetchStoreListingTag(db).listForListings(page.map((row) => row.id)),
    fetchStoreListingTag(db).listDistinct(TAG_CLOUD),
    isFiltered(query) || query.cursor !== null
      ? Promise.resolve([])
      : listings.featuredQuery(FEATURED).execute(),
  ])

  // featuredQuery falls back to star order when nothing is ranked, which on a small catalogue
  // means the rail is just the first three cards again. A rail that says "start here" has to be
  // a choice someone made, so it only appears once a listing actually carries a rank.
  const ranked = featured.filter((row) => row.featuredRank !== null)
  const featuredTags = await fetchStoreListingTag(db).listForListings(ranked.map((row) => row.id))

  return (
    <>
      <Nav homeHref="/" />
      <main className="pt-16">
        <section className="border-b rule-soft py-16 sm:py-20">
          <div className="container-page">
            <p className="eyebrow mb-4">The app store</p>
            <h1 className="max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.75rem] sm:leading-[1.05]">
              Apps that already work. Fork one and make it yours.
            </h1>
            <p className="mt-5 max-w-2xl text-muted-foreground text-pretty">
              Every app here is open source and already running for someone. Forking one copies it
              into your account, provisions the database and services it declares, and deploys it.
              Then you describe what you want changed, in a sentence.
            </p>

            <StoreFilters categories={categories} tags={tagCloud} query={query} />
          </div>
        </section>

        {ranked.length > 0 && (
          <section className="border-b rule-soft py-14">
            <div className="container-page">
              <h2 className="eyebrow mb-6">Start here</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {ranked.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    tags={featuredTags.get(listing.id) ?? []}
                  />
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="py-14 sm:py-16">
          <div className="container-page">
            <h2 className="eyebrow mb-6">
              {query.q === null ? "Everything in the store" : `Results for “${query.q}”`}
            </h2>

            {page.length === 0 ? (
              <EmptyState query={query} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {page.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    tags={tagsByListing.get(listing.id) ?? []}
                  />
                ))}
              </div>
            )}

            {hasNext && (
              <div className="mt-10 flex justify-center">
                <Link
                  href={storeHref({ ...query, cursor: page[page.length - 1].id })}
                  rel="next"
                  className="rounded-lg border rule-soft px-5 py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  More apps
                </Link>
              </div>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}

function EmptyState({ query }: { query: StoreQuery }) {
  return (
    <div className="rounded-2xl border rule-soft bg-card/60 px-6 py-14 text-center">
      <p className="font-display text-lg font-semibold tracking-tight">Nothing matched.</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground text-pretty">
        The store is small on purpose — every listing is an app we have actually run. Try a broader
        search, or browse everything.
      </p>
      {isFiltered(query) && (
        <Link
          href="/store"
          className="mt-6 inline-block rounded-lg border border-primary/45 bg-primary/10 px-4 py-2 text-sm text-primary transition-colors hover:bg-primary/15"
        >
          Clear filters
        </Link>
      )}
    </div>
  )
}
