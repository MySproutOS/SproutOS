import { fetchStoreListing } from "@lib/dao/storeListing/fetch"
import { db } from "@sproutos/db"
import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"
import { ForkMaintenance } from "./_components/fork-maintenance"
import { PersonalizeFlow } from "./_components/personalize-flow"

export const metadata: Metadata = {
  title: "Personalize apps and websites — SproutOS",
  description:
    "Start from an open source app that already works, describe the change you want, and keep it. " +
    "Someone else maintains the core; you maintain the few details that are yours.",
  alternates: { canonical: "/personalize" },
}

/**
 * Rendered per request, like `/store` is.
 *
 * The showcase reads the catalogue, so prerendering this page would freeze the list at build time —
 * a listing published afterwards would never appear, and the build itself would start needing a
 * reachable database.
 */
export const dynamic = "force-dynamic"

const SHOWCASE = 6

const WHY = [
  {
    title: "You are not building from scratch",
    body: "The expensive part of having your own app is the first version — the schema, the auth, the hundred screens nobody demos. That part already exists and already works.",
  },
  {
    title: "You still mostly use your favourite app",
    body: "A personalization is a handful of files, not a rewrite. Ninety-nine percent of what you run is the app you already chose, behaving the way you already know.",
  },
  {
    title: "Somebody else keeps the core alive",
    body: "The upstream maintainers go on maintaining. You are not inheriting a codebase; you are adding a detail to one that has a community around it.",
  },
  {
    title: "Personalizing is cheap enough to try",
    body: "You describe the change in a sentence and it runs for cents a month, so the idea does not have to be worth a project before you are allowed to have it.",
  },
] as const

/**
 * The showcase reads the live catalogue rather than a hardcoded list.
 *
 * Marketing copy that names apps goes stale the first time a listing is withdrawn — two already
 * have been — and a page promising a store that lists something the store does not have is the
 * worst version of this page. Same DAO the store itself uses.
 */
async function extensibleListings() {
  return fetchStoreListing(db).browseQuery({}).limit(SHOWCASE).execute()
}

export default async function PersonalizePage() {
  const listings = await extensibleListings()

  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
          <Reveal>
            <p className="eyebrow mb-4">Personalization</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              You don't need to build an app. You need to change one.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Almost nobody wants software nobody has written before. What people actually want is
              the app they already like, with the one thing it does not do. Personalizing an open
              source app gets you that in a sentence, and leaves the rest of it — the part that
              works, and the people maintaining it — exactly where it was.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <LoginWithGitHubButton size="xl" />
              <Link
                href="/store"
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/70 hover:bg-primary/12"
              >
                Browse the web store
                <span aria-hidden="true">→</span>
              </Link>
            </div>
            <p className="mt-5 font-mono text-xs text-muted-foreground">
              Web and Android · Your own database · Cents a month
            </p>
          </Reveal>

          <Reveal delay={100} className="flex justify-center lg:justify-end">
            <PersonalizeFlow />
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Why this beats building</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Four fifths of the work was already done by somebody who cared about it.
            </h2>
          </Reveal>
          <dl className="mt-12 grid gap-8 sm:grid-cols-2 lg:gap-10">
            {WHY.map((item, i) => (
              <Reveal key={item.title} delay={i * 70} className="border-t-2 border-primary/40 pt-5">
                <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                  {item.title}
                </dt>
                <dd className="mt-3 text-sm text-muted-foreground text-pretty">{item.body}</dd>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Worth extending</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Apps in the store that people actually personalize.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              The catalogue is small on purpose — every listing is an app we have run ourselves.
              These are the ones where a small change is the difference between nearly right and
              yours.
            </p>
          </Reveal>

          {listings.length === 0 ? (
            <p className="mt-10 text-sm text-muted-foreground">
              The catalogue is being set up.{" "}
              <Link href="/store" className="text-primary">
                Check the store
              </Link>{" "}
              for what is live.
            </p>
          ) : (
            <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {listings.map((listing, i) => (
                <RevealItem
                  key={listing.id}
                  delay={i * 60}
                  className="relative h-full rounded-2xl border rule-soft bg-card/60 p-6 transition-colors hover:border-primary/40"
                >
                  <h3 className="font-display text-base font-semibold tracking-tight">
                    <Link
                      href={`/store/${listing.slug}`}
                      className="before:absolute before:inset-0"
                    >
                      {listing.name}
                    </Link>
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground text-pretty">
                    {listing.tagline}
                  </p>
                  <p className="mt-4 font-mono text-xs text-muted-foreground">
                    {listing.upstreamOwner}/{listing.upstreamRepo} · {listing.licenseSpdx}
                  </p>
                </RevealItem>
              ))}
            </ul>
          )}

          <Reveal delay={100}>
            <Link
              href="/store"
              className="mt-10 inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/70 hover:bg-primary/12"
            >
              See the whole store
              <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        </div>
      </section>

      <ForkMaintenance />

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page grid gap-10 sm:grid-cols-2 lg:gap-14">
          <Reveal className="rounded-2xl border rule-soft bg-card/60 p-7 sm:p-8">
            <p className="eyebrow mb-3">On the web</p>
            <h2 className="font-display text-xl font-semibold tracking-tight">The web store</h2>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              Every listing, forkable from the browser. You can look around without an account —
              signing in is what it takes to make a copy, not to read the shelf.
            </p>
            <Link
              href="/store"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:underline"
            >
              Open the web store <span aria-hidden="true">→</span>
            </Link>
          </Reveal>

          <Reveal delay={80} className="rounded-2xl border rule-soft bg-card/60 p-7 sm:p-8">
            <p className="eyebrow mb-3">On Android</p>
            <h2 className="font-display text-xl font-semibold tracking-tight">
              The Android client
            </h2>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              A public catalogue and your own apps in one place, with the websites you have deployed
              alongside them. Not on Google Play — the download page shows the checksums and walks
              through the permission Android will ask for.
            </p>
            <Link
              href="/download"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:underline"
            >
              Get it for Android <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        </div>
      </section>
    </>
  )
}
