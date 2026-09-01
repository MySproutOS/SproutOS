import Link from "next/link"

export type StoreCardListing = {
  slug: string
  name: string
  tagline: string
  starsCount: number
  installCount: number
  licenseSpdx: string | null
  upstreamOwner: string
  upstreamRepo: string
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export function ListingCard({ listing, tags }: { listing: StoreCardListing; tags: string[] }) {
  return (
    <article className="group relative flex flex-col rounded-2xl border rule-soft bg-card/60 p-5 transition-colors hover:border-primary/40">
      <h3 className="font-display text-base font-semibold tracking-tight">
        {/* The whole card is the target, but only the title is the link — one anchor per card
            keeps the accessible name meaningful and the crawlable text honest. */}
        <Link href={`/store/${listing.slug}`} className="before:absolute before:inset-0">
          {listing.name}
        </Link>
      </h3>

      <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground text-pretty">
        {listing.tagline}
      </p>

      {tags.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {tags.slice(0, 4).map((tag) => (
            <li
              key={tag}
              className="rounded-full border rule-soft px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}

      {/* A zero here means "not synced from upstream yet", not "nobody uses this". Printing it
          reads as the second thing, so an unsynced counter is simply left out. */}
      <dl className="mt-4 flex items-center gap-4 border-t rule-soft pt-3 font-mono text-[11px] text-muted-foreground tnum">
        {listing.starsCount > 0 && (
          <div className="flex gap-1">
            <dt className="sr-only">Stars</dt>
            <dd>★ {compact.format(listing.starsCount)}</dd>
          </div>
        )}
        {listing.installCount > 0 && (
          <div className="flex gap-1">
            <dt className="sr-only">Installs on SproutOS</dt>
            <dd>{compact.format(listing.installCount)} installs</dd>
          </div>
        )}
        {listing.licenseSpdx !== null && (
          <div className="ml-auto flex gap-1">
            <dt className="sr-only">License</dt>
            <dd>{listing.licenseSpdx}</dd>
          </div>
        )}
      </dl>
    </article>
  )
}
