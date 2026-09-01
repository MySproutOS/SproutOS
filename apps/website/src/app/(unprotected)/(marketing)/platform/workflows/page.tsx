import { Button } from "@ui/base/ui/button"
import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"
import { CostCard, PRICE_DISCLOSURE } from "../_components/cost-card"

export const metadata: Metadata = {
  title: "Workflows — SproutOS",
  description:
    "Scheduled jobs and background work billed by the run instead of by the month. A job that " +
    "runs for two seconds a day costs what two seconds a day is worth.",
  alternates: { canonical: "/platform/workflows" },
}

const EXAMPLES = [
  {
    name: "A plugin backend for Obsidian or Notion",
    body: "Sync, transform and enrich your own notes on your own schedule, against a database only you can reach. No shared cloud, no third party holding the vault.",
  },
  {
    name: "A news digest that reads what you actually follow",
    body: "Pull the feeds, cluster the repeats, summarise the rest, send one email at seven. Runs for a couple of seconds a day and bills like it.",
  },
  {
    name: "An inbox summariser",
    body: "Read overnight mail, group it, surface the three things that need an answer. Private by construction: it is your code, in your project, talking to your account.",
  },
] as const

const VS_N8N = [
  {
    label: "The nodes, without the box",
    body: "n8n is a good editor attached to a server somebody has to keep upright. Self-hosting it means a machine that is awake all month so it can be busy for twelve hours of it, plus the patching, plus the upgrade that breaks a credential.",
  },
  {
    label: "Cloud n8n bills by execution volume",
    body: "You move from paying for an idle box to paying a monthly plan sized by how many times your automations ran. Either way, the meter is not the work.",
  },
  {
    label: "Here it is code, in your repository",
    body: "Which means it is reviewable, diffable and yours — and it can do the things a node palette does not have a node for, because there is no palette.",
  },
] as const

export default function WorkflowsPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Workflows &amp; background jobs</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              A per-minute schedule is not a bigger job than a daily one.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              It is the same second of work, 43,200 times. The reason automation is expensive
              everywhere else is not the work — it is having somewhere for the work to happen at
              all, awake and waiting, twenty-four hours a day, for the twelve seconds it is needed.
            </p>
            <p className="mt-4 text-lg text-muted-foreground text-pretty">
              Ours sleeps when there is no work. We have not found anyone who does it cheaper.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Priced both ways</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Somewhere for it to happen.
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <Reveal className="h-full">
              <CostCard
                eyebrow="Workflows & background jobs"
                title="Things that run without anyone watching"
                body="A sync every minute, a nightly import, a follow-up that fires three days later. The work itself is seconds; the cost is in having somewhere for it to happen at all."
                ours={{ amount: "$0.01", unit: "/mo", note: "43,200 runs — one a minute" }}
                theirs={[
                  {
                    label: "Vercel Cron, once a minute",
                    detail: "Hobby's minimum interval is once a day, so this needs Pro at $20/mo",
                    monthly: 20,
                  },
                  {
                    label: "An EC2 worker sitting there",
                    detail: "t4g.nano awake all month to be busy for twelve hours of it",
                    monthly: 7.36,
                  },
                ]}
                footnote="Paying by the run makes that cost what it weighs. Nothing is reserved for you between runs, so nothing is billed between runs."
              />
            </Reveal>

            <Reveal delay={80} className="h-full">
              <div className="flex h-full flex-col rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
                <p className="eyebrow mb-4">Compared with n8n</p>
                <h3 className="font-display text-xl font-semibold tracking-tight text-balance">
                  The same capability, minus the trapdoor.
                </h3>
                <dl className="mt-6 flex flex-col gap-5">
                  {VS_N8N.map((row) => (
                    <div key={row.label}>
                      <dt className="text-sm font-medium text-foreground">{row.label}</dt>
                      <dd className="mt-1.5 text-sm text-muted-foreground text-pretty">
                        {row.body}
                      </dd>
                    </div>
                  ))}
                </dl>
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
            <p className="eyebrow mb-4">What people actually build</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Nobody has to build it, either.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              You describe what should happen and when. No engineer to borrow, no ticket, no
              self-hosted automation server for someone to keep upright. Five minutes, in your own
              words.
            </p>
          </Reveal>

          <ul className="mt-12 grid gap-5 md:grid-cols-3">
            {EXAMPLES.map((example, i) => (
              <RevealItem
                key={example.name}
                delay={i * 80}
                className="h-full rounded-2xl border rule-soft bg-card/60 p-6"
              >
                <h3 className="font-display text-base font-semibold tracking-tight text-balance">
                  {example.name}
                </h3>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{example.body}</p>
              </RevealItem>
            ))}
          </ul>

          <Reveal delay={100}>
            <p className="mt-8 max-w-2xl text-sm text-muted-foreground text-pretty">
              All of it private by default — your code, your database, your account. The cheap
              version of this elsewhere is someone else's cloud reading your notes. The mechanics of
              scheduling, retries and logs are in the{" "}
              <Link href="/docs/background-workers" className="text-primary hover:underline">
                background workers documentation
              </Link>
              .
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
