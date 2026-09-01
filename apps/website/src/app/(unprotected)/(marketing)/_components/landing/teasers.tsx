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
    body: "Start from software that already works and add the one thing it was missing.",
    href: "/personalize",
    cta: "How personalizing works",
  },
  {
    eyebrow: "Data ownership",
    title: "The database has your name on it",
    body: "Query across your apps, and leave with the rows when you want to.",
    href: "/data-ownership",
    cta: "Owning your data",
  },
  {
    eyebrow: "Platform",
    title: "It sleeps when nothing is happening",
    body: "Databases, workflows and sites — each billed by what it actually did.",
    href: "/platform/databases",
    cta: "What it costs",
  },
  {
    eyebrow: "For business",
    title: "Too cheap to need approval",
    body: "Too cheap to need approval, and nothing for IT to keep running.",
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
          <h2 className="font-display text-2xl font-semibold tracking-tight text-balance">
            Four arguments, and where each one is made.
          </h2>
        </Reveal>

        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TEASERS.map((teaser, i) => (
            <RevealItem
              key={teaser.href}
              delay={i * 70}
              className="relative flex h-full flex-col border-t-2 border-primary/40 pt-5"
            >
              <p className="eyebrow mb-2.5">{teaser.eyebrow}</p>
              <h3 className="font-display text-[1.0625rem] font-semibold tracking-tight text-balance">
                <Link href={teaser.href} className="before:absolute before:inset-0">
                  {teaser.title}
                </Link>
              </h3>
              <p className="mt-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground text-pretty">
                {teaser.body}
              </p>
              <p className="mt-4 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-primary">
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
