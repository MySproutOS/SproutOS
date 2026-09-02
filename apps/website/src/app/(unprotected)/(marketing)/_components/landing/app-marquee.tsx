import { StoreBadge, AndroidBadge } from "../store-badge"
import { Reveal } from "@ui/spa-shared/reveal"
import Link from "next/link"

export type MarqueeListing = {
  id: string
  slug: string
  name: string
  tagline: string
  upstreamOwner: string
  upstreamRepo: string
  licenseSpdx: string | null
}

const MINIMUM_ITEMS_PER_MARQUEE_COPY = 12

export function buildMarqueeSequence(listings: MarqueeListing[]) {
  const repetitions = Math.max(1, Math.ceil(MINIMUM_ITEMS_PER_MARQUEE_COPY / listings.length))

  return Array.from({ length: repetitions }, (_, repetition) =>
    listings.map((listing) => ({ listing, repetition })),
  ).flat()
}

/**
 * The catalogue, moving.
 *
 * A continuously scrolling rail rather than a paged carousel: there is no "page 2" worth landing
 * on, and motion is what says *there are more of these* without spending a section's worth of
 * height saying it.
 *
 * The sequence is rendered twice. Short catalogues repeat within each sequence so one copy remains
 * wider than the viewport; otherwise both real cards can leave before the duplicate reaches the
 * screen. The animation translates the track by exactly -50%, so at the moment it resets, the
 * second copy is sitting precisely where the first began and the seam is invisible.
 *
 * `animation` is dropped entirely under `prefers-reduced-motion` — see `utilities.css`, where the
 * same block already flattens the scroll reveals. A marquee is the most literal case of the thing
 * that setting exists to stop.
 */
export function AppMarquee({ listings }: { listings: MarqueeListing[] }) {
  if (listings.length === 0) return null

  const sequence = buildMarqueeSequence(listings)

  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <Reveal className="container-page">
        <p className="eyebrow mb-4">The catalogue</p>
        <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
          Start from an app that already works.
        </h2>
      </Reveal>

      <div className="marquee mt-10">
        <div className="marquee-track">
          {[0, 1].map((copy) => (
            <ul key={copy} className="flex gap-5 pr-5" aria-hidden={copy === 1}>
              {sequence.map(({ listing, repetition }) => {
                const isAccessible = copy === 0 && repetition === 0

                return (
                  <li
                    key={`${copy}-${repetition}-${listing.id}`}
                    aria-hidden={!isAccessible}
                    className="relative w-[19rem] shrink-0 rounded-2xl border rule-soft bg-card/60 p-6 transition-colors hover:border-primary/40"
                  >
                    <h3 className="font-display text-[1.0625rem] font-semibold tracking-tight">
                      {isAccessible ? (
                        <Link
                          href={`/store/${listing.slug}`}
                          className="before:absolute before:inset-0"
                        >
                          {listing.name}
                        </Link>
                      ) : (
                        listing.name
                      )}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground text-pretty">
                      {listing.tagline}
                    </p>
                    <p className="mt-4 font-mono text-xs text-muted-foreground">
                      {listing.upstreamOwner}/{listing.upstreamRepo}
                      {/* Nullable in the schema — a missing licence must not print a bare separator. */}
                      {listing.licenseSpdx === null ? null : ` · ${listing.licenseSpdx}`}
                    </p>
                  </li>
                )
              })}
            </ul>
          ))}
        </div>
      </div>

      <div className="container-page">
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          {listings.length} {listings.length === 1 ? "app" : "apps"} in the store · hover to pause
        </p>

        <Reveal delay={80} className="mt-10 flex flex-wrap gap-4">
          <StoreBadge />
          <AndroidBadge />
        </Reveal>
      </div>
    </section>
  )
}
