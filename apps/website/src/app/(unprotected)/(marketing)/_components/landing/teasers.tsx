import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import Link from "next/link"

/*
  The landing page is a map now, not the argument itself.

  It used to carry all seven arguments end to end, which meant the only way to find out what
  SproutOS does about, say, switching costs was to scroll past everything else first. Each argument
  now has a page; this is the shortest honest version of each, with a door.

  These teasers are the one place the copy is duplicated, so they are deliberately written as
  summaries rather than excerpts — a summary that drifts from its page reads as a summary, an
  excerpt that drifts reads as a contradiction.
*/

const TEASERS = [
  {
    eyebrow: "Personalization",
    title: "Change an app instead of building one",
    body: "Start from open source software that already works, say what you want different, and keep using the app you already liked. Somebody else goes on maintaining the core; SproutOS keeps your copy current with it.",
    href: "/personalize",
    cta: "How personalizing works",
  },
  {
    eyebrow: "Data ownership",
    title: "The database has your name on it",
    body: "Every app you run writes into one Postgres you can open, query across, and leave with. Switching costs collapse when the data was never in the vendor's database to begin with.",
    href: "/data-ownership",
    cta: "Owning your data",
  },
  {
    eyebrow: "Platform",
    title: "It sleeps when nothing is happening",
    body: "Postgres, a cache, search, workflows and the site itself, each suspended when idle and billed by use. A managed database elsewhere is billed by the hour it exists, not the hour it is queried.",
    href: "/platform/databases",
    cta: "What it costs",
  },
  {
    eyebrow: "For business",
    title: "Too cheap to need approval",
    body: "A department's worth of automations bills in cents, with nothing for IT to run and nobody to borrow. The idea does not have to survive a procurement conversation, because it never starts one.",
    href: "/business/employees",
    cta: "For teams",
  },
] as const

export function Teasers() {
  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">What SproutOS is</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Four arguments, and where each one is made.
          </h2>
        </Reveal>

        <ul className="mt-12 grid gap-5 md:grid-cols-2">
          {TEASERS.map((teaser, i) => (
            <RevealItem
              key={teaser.href}
              delay={i * 70}
              className="relative flex h-full flex-col rounded-2xl border rule-soft bg-card/60 p-7 transition-colors hover:border-primary/40 sm:p-8"
            >
              <p className="eyebrow mb-3">{teaser.eyebrow}</p>
              <h3 className="font-display text-xl font-semibold tracking-tight text-balance">
                <Link href={teaser.href} className="before:absolute before:inset-0">
                  {teaser.title}
                </Link>
              </h3>
              <p className="mt-3 text-sm text-muted-foreground text-pretty">{teaser.body}</p>
              <p className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                {teaser.cta}
                <span aria-hidden="true">→</span>
              </p>
            </RevealItem>
          ))}
        </ul>
      </div>
    </section>
  )
}
