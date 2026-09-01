import { Button } from "@ui/base/ui/button"
import { Reveal } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Owning your data — SproutOS",
  description:
    "Your data sits in a Postgres database with your name on it: one place to query across every " +
    "app you run, and nothing holding you in place when you want to leave.",
  alternates: { canonical: "/data-ownership" },
}

const POINTS = [
  {
    title: "A database per person",
    body: "Because databases are cheap to spin up, an app can sign you in with SproutOS OAuth and hand you a database of your own. Privacy stops being a policy and starts being an architecture.",
  },
  {
    title: "No fork required to own it",
    body: "If the original app supports personalized databases, your data is yours without maintaining any code at all. Ownership and personalization are separate decisions.",
  },
  {
    title: "Leaving is a prompt, not a project",
    body: "Point a coding agent at your database and move to another app in the same category. Low switching costs are what let a diverse app ecosystem exist at all.",
  },
] as const

const CROSS_APP = [
  {
    label: "It is one Postgres, not five exports",
    body: "Every app you run against your SproutOS database writes into a database you can open. Asking a question that spans two of them is a join, not a support ticket and a CSV.",
  },
  {
    label: "You can read it without asking anybody",
    body: "A connection string is a connection string. Point psql, a notebook, a BI tool or a coding agent at it — nothing here mediates your access to your own rows.",
  },
  {
    label: "You can correct it yourself",
    body: "The thing every app gets wrong about your data is different, and none of them ship the screen you need. An UPDATE does not require the vendor to agree with you.",
  },
] as const

const SWITCHING = [
  {
    step: "Normally",
    body: "Your data lives in the vendor's database. Leaving means finding an export, discovering what it omits, and rebuilding the shape by hand — so mostly you do not leave, and the vendor knows it.",
  },
  {
    step: "Here",
    body: "The data was never in their database. Switching is moving your own rows from one schema to another, which is exactly the kind of tedious, well-specified work a coding agent is good at.",
  },
  {
    step: "Which changes what gets built",
    body: "When leaving is cheap, a new app only has to be better than the incumbent — not better by enough to justify losing five years of history. That is the difference between an ecosystem and three winners.",
  },
] as const

export default function DataOwnershipPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/3 left-1/2 -z-10 h-[28rem] w-[52rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/6 blur-[120px]"
        />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Data ownership</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              Your data sits in a database with your name on it.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Data ownership and personalization are the two things SproutOS is actually built
              around. Everything else — the cheap compute, the sleeping databases, the app store —
              is plumbing in service of them.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border rule-soft bg-border/60 md:grid-cols-3">
            {POINTS.map((point, i) => (
              <Reveal key={point.title} delay={i * 80} className="bg-card/70 p-7">
                <h2 className="font-display text-lg font-semibold tracking-tight">{point.title}</h2>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{point.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Cross-app analysis</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              The interesting questions are the ones that span two apps.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              How much of what you read gets saved and never opened again. Whether the weeks you
              logged the most tasks were the weeks you slept least. No single vendor will ever build
              that, because it needs data from a product they do not sell — and when every app
              writes into a database that is yours, nobody has to.
            </p>
          </Reveal>
          <dl className="mt-12 grid gap-8 md:grid-cols-3 lg:gap-10">
            {CROSS_APP.map((item, i) => (
              <Reveal key={item.label} delay={i * 80} className="border-l-2 border-primary/40 pl-6">
                <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                  {item.label}
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
            <p className="eyebrow mb-4">Switching costs</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Most software is not kept because it is good. It is kept because leaving is expensive.
            </h2>
          </Reveal>

          <ol className="mt-12 flex flex-col gap-px overflow-hidden rounded-2xl border rule-soft bg-border/60">
            {SWITCHING.map((row, i) => (
              <Reveal key={row.step} delay={i * 80}>
                <li className="grid gap-3 bg-card/70 p-7 sm:grid-cols-[10rem_1fr] sm:gap-8">
                  <p className="eyebrow pt-1">{row.step}</p>
                  <p className="text-sm text-muted-foreground text-pretty">{row.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>

          <Reveal delay={100}>
            <p className="mt-8 max-w-3xl text-sm text-muted-foreground text-pretty">
              This only works as far as developers are willing to implement it — an app that insists
              on its own central database is still an app that owns your rows. That is the argument
              on the{" "}
              <Link href="/data-ownership/developers" className="text-primary hover:underline">
                developers page
              </Link>
              , and it is the part of this we cannot do alone.
            </p>
          </Reveal>

          <Reveal delay={140} className="mt-12 flex justify-center">
            <Button size="xl" variant="outline" render={<Link href="/login">Get started</Link>} />
          </Reveal>
        </div>
      </section>
    </>
  )
}
