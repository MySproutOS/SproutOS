import { fetchStoreListing } from "@lib/dao/storeListing/fetch"
import { fetchStoreListingScreenshot } from "@lib/dao/storeListingScreenshot/fetch"
import { fetchStoreListingTag } from "@lib/dao/storeListingTag/fetch"
import { db } from "@sproutos/db"
import { Button } from "@ui/base/ui/button"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Markdown } from "../_components/markdown"

type Params = { params: Promise<{ slug: string }> }

/**
 * The reason this page is server-rendered at all: a listing is a shareable, crawlable page for an
 * app someone might want, and a client-rendered one has nothing in it to share or crawl.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const listing = await fetchStoreListing(db).getBySlug(slug, ["name", "tagline"])
  if (listing === undefined) return { title: "Not found — SproutOS" }

  return {
    title: `${listing.name} — SproutOS app store`,
    description: listing.tagline,
    alternates: { canonical: `/store/${slug}` },
    openGraph: {
      type: "website",
      title: `${listing.name} on SproutOS`,
      description: listing.tagline,
      url: `/store/${slug}`,
    },
  }
}

const number = new Intl.NumberFormat("en-US")

export default async function ListingPage({ params }: Params) {
  const { slug } = await params

  // getPublishedDetail filters on status, so a draft or rejected listing 404s here exactly as an
  // absent one does. Unreviewed markdown is never rendered, and "exists but is hidden" is not a
  // distinction a visitor is entitled to.
  const listing = await fetchStoreListing(db).getPublishedDetail(slug)
  if (listing === undefined) notFound()

  const [tags, screenshots] = await Promise.all([
    fetchStoreListingTag(db).listForListing(listing.id),
    fetchStoreListingScreenshot(db).listForListing(listing.id, ["id", "url", "altText"]),
  ])

  return (
    <>
      <section className="border-b rule-soft py-14 sm:py-16">
        <div className="container-page">
          <nav
            aria-label="Breadcrumb"
            className="mb-6 flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Link href="/store" className="transition-colors hover:text-foreground">
              App store
            </Link>
            <span aria-hidden="true">/</span>
            {listing.categorySlug !== null && (
              <>
                <Link
                  href={`/store?category=${listing.categorySlug}`}
                  className="transition-colors hover:text-foreground"
                >
                  {listing.categoryName}
                </Link>
                <span aria-hidden="true">/</span>
              </>
            )}
            <span className="text-foreground">{listing.name}</span>
          </nav>

          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <h1 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
                {listing.name}
              </h1>
              <p className="mt-4 text-lg text-muted-foreground text-pretty">{listing.tagline}</p>

              {tags.length > 0 && (
                <ul className="mt-6 flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <li key={tag}>
                      <Link
                        href={`/store?tag=${encodeURIComponent(tag)}`}
                        className="block rounded-full border rule-soft px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                      >
                        {tag}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="w-full shrink-0 rounded-2xl border rule-soft bg-card/60 p-5 lg:w-80">
              <p className="eyebrow mb-3">Make it yours</p>
              <Button
                className="w-full"
                render={
                  // `next` survives the round trip: `sign-in-form.tsx` reads it from searchParams
                  // and returns here rather than to the dashboard.
                  <Link href={`/login?next=${encodeURIComponent(`/store/${listing.slug}`)}`}>
                    Fork this app
                  </Link>
                }
              />
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground text-pretty">
                Forking copies {listing.name} into your own GitHub account and deploys it with its
                own database. Nothing is shared with the original.
              </p>

              <dl className="mt-5 space-y-2.5 border-t rule-soft pt-4 text-xs">
                <Fact label="Upstream">
                  <a
                    href={listing.upstreamRepoUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="font-mono text-primary hover:underline"
                  >
                    {listing.upstreamOwner}/{listing.upstreamRepo}
                  </a>
                </Fact>
                {listing.licenseSpdx !== null && (
                  <Fact label="License">
                    <span className="font-mono">{listing.licenseSpdx}</span>
                  </Fact>
                )}
                {/* Zero means unsynced, not unpopular — see the same rule on the card. */}
                {listing.starsCount > 0 && (
                  <Fact label="Stars">
                    <span className="font-mono tnum">{number.format(listing.starsCount)}</span>
                  </Fact>
                )}
                {listing.installCount > 0 && (
                  <Fact label="Installs">
                    <span className="font-mono tnum">{number.format(listing.installCount)}</span>
                  </Fact>
                )}
                {listing.homepageUrl !== null && (
                  <Fact label="Homepage">
                    <a
                      href={listing.homepageUrl}
                      rel="nofollow noopener noreferrer"
                      target="_blank"
                      className="text-primary hover:underline"
                    >
                      Visit
                    </a>
                  </Fact>
                )}
              </dl>
            </div>
          </div>
        </div>
      </section>

      {screenshots.length > 0 && (
        <section className="border-b rule-soft py-12">
          <div className="container-page grid gap-4 sm:grid-cols-2">
            {screenshots.map((shot) => (
              // eslint-disable-next-line @next/next/no-img-element -- remote, unoptimizable
              <img
                key={shot.id}
                src={shot.url}
                alt={shot.altText ?? `${listing.name} screenshot`}
                loading="lazy"
                className="w-full rounded-xl border rule-soft"
              />
            ))}
          </div>
        </section>
      )}

      <section className="py-14 sm:py-16">
        <div className="container-page max-w-3xl">
          <Markdown>{listing.descriptionMd}</Markdown>

          {listing.readmeMd !== null && (
            <details className="mt-12 rounded-2xl border rule-soft bg-card/60 p-6">
              <summary className="cursor-pointer font-display text-base font-semibold tracking-tight">
                The project's README
              </summary>
              <div className="mt-6 border-t rule-soft pt-6">
                <Markdown>{listing.readmeMd}</Markdown>
              </div>
            </details>
          )}
        </div>
      </section>
    </>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}
