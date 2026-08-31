import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"
import { CostCard, PRICE_DISCLOSURE } from "../_components/cost-card"

export const metadata: Metadata = {
  title: "Databases — SproutOS",
  description:
    "Postgres, Valkey and OpenSearch, each tenant-split and suspended when nobody is using them. " +
    "Billed by what you use rather than by the hour the instance exists.",
  alternates: { canonical: "/platform/databases" },
}

const ENGINES = [
  {
    name: "Postgres",
    body: "Your data. A real Postgres you can connect to with a connection string, not a wrapper with a query language of its own.",
    idle: "Suspends when idle and wakes on the next connection.",
  },
  {
    name: "Valkey",
    body: "Caching and queues. Tenant-split, with an engine-enforced identity rather than a prefix convention everyone has to remember.",
    idle: "Shared capacity, so an idle queue occupies almost nothing.",
  },
  {
    name: "OpenSearch",
    body: "Search, when a LIKE query stops being enough. Also tenant-split, and also not something you have to name or size in advance.",
    idle: "Storage while it sits there; you pay for queries when they happen.",
  },
] as const

export default function DatabasesPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Databases</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              A managed database is billed by the hour it exists, not the hour it is queried.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              That single sentence is why a small app costs fifty dollars a month somewhere else and
              cents here. Everything on SproutOS suspends when nothing is happening, and for almost
              every app, almost nothing is happening almost all of the time.
            </p>
          </Reveal>

          <ul className="mt-12 grid gap-5 md:grid-cols-3">
            {ENGINES.map((engine, i) => (
              <RevealItem
                key={engine.name}
                delay={i * 80}
                className="h-full rounded-2xl border rule-soft bg-card/60 p-6"
              >
                <h2 className="font-display text-lg font-semibold tracking-tight">{engine.name}</h2>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{engine.body}</p>
                <p className="mt-4 font-mono text-xs text-primary text-pretty">{engine.idle}</p>
              </RevealItem>
            ))}
          </ul>

          <Reveal delay={120}>
            <p className="mt-8 max-w-3xl text-muted-foreground text-pretty">
              You do not need to know which of these you want. You describe what the app should do,
              and SproutOS picks the pieces and wires them together.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Priced both ways</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              The same three things, rented yourself.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              These are the cheapest options each vendor sells — the smallest instance and the
              smallest disk — not a typical bill. The gap is not a discount we are funding. It is
              that none of them can be turned down when idle.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <Reveal className="h-full">
              <CostCard
                eyebrow="Databases"
                title="Postgres, a cache, and search"
                body="SproutOS gives you all three: Postgres for your data, Valkey for caching and queues, and OpenSearch for search. Each is tenant-split and suspends when nobody is using it, which is the entire reason the number below is a number of cents."
                ours={{ amount: "$0.02", unit: "/mo", note: "1,000 accounts" }}
                theirs={[
                  {
                    label: "RDS Postgres",
                    detail: "db.t4g.micro + 20 GB — the smallest one AWS sells",
                    monthly: 13.98,
                  },
                  { label: "ElastiCache", detail: "cache.t4g.micro", monthly: 11.68 },
                  {
                    label: "OpenSearch",
                    detail: "one t3.small.search node",
                    monthly: 26.28,
                  },
                ]}
                totalMode="sum"
                totalLabel="All three, always on"
                footnote="None of these can be turned down when idle. That is the same $51.94 whether a thousand people use your app this month or nobody does."
                note={{
                  label: "How Supabase's project limit is priced",
                  text: "On Supabase's free tier, two is the most databases you can have running at once.",
                  detail:
                    "The free tier allows two *active* projects — paused ones do not count against it. A third means Pro at $25/mo, and each project past the first adds its own compute on top, around $10/mo. So a handful of small automations, each with its own isolated database, leaves the free tier at the third one.",
                }}
              />
            </Reveal>

            <Reveal delay={80} className="h-full">
              <div className="flex h-full flex-col justify-center rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
                <p className="eyebrow mb-4">Why a database per person is possible at all</p>
                <p className="text-muted-foreground text-pretty">
                  At fifty dollars a month per stack, one database per user is a business model
                  nobody can run. At cents, it is just how you would build it if you were not
                  worried about the bill — which is why the data-ownership argument on this site is
                  a consequence of the pricing rather than a slogan attached to it.
                </p>
                <Link
                  href="/data-ownership"
                  className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:underline"
                >
                  What that gets you <span aria-hidden="true">→</span>
                </Link>
              </div>
            </Reveal>
          </div>

          <Reveal delay={120}>
            <p className="mt-8 max-w-3xl text-sm text-muted-foreground text-pretty">
              {PRICE_DISCLOSURE}
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">How it is billed</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Usage, prepaid, with no monthly floor.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              There is no seat, no plan and no minimum spend — you top up credit and work draws it
              down. Storage is charged per gigabyte-month, compute per second it is awake, and
              queries per query. When credit runs out, new work is refused rather than quietly
              billed to a card.
            </p>
            <p className="mt-4 text-muted-foreground text-pretty">
              The exact per-dimension rates and the platform fee on each are in the{" "}
              <Link href="/docs/billing" className="text-primary hover:underline">
                billing documentation
              </Link>
              .
            </p>
          </Reveal>

          <Reveal delay={120} className="mt-12 flex justify-center">
            <LoginWithGitHubButton size="xl" variant="outline" />
          </Reveal>
        </div>
      </section>
    </>
  )
}
