import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal, RevealItem } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "SproutOS for employees — SproutOS",
  description:
    "Automate your own work without a developer and without a budget line. A department's worth " +
    "of automations bills in cents, so the idea never has to survive a procurement conversation.",
  alternates: { canonical: "/business/employees" },
}

const ANSWERS = [
  {
    label: "You do not need to be technical",
    body: "You describe what should happen and when, in your own words. There is no node palette to learn and no script to write — the same conversation you would have with a colleague who was going to do it for you.",
  },
  {
    label: "You do not need a developer",
    body: "No engineer to borrow, no ticket, no waiting for a sprint. This is the category of work that is too small to ever get prioritised and too annoying to keep doing by hand.",
  },
  {
    label: "You do not need a budget",
    body: "Your own automations come to cents a month. There is no seat to buy, no plan, and no minimum — which means there is nothing for anyone to approve.",
  },
] as const

const EXAMPLES = [
  {
    name: "The follow-up that cancels itself",
    body: "A client has not replied in three days, so a reminder goes out — unless they replied in the meantime, in which case nothing happens. CSMs ask for this constantly and it never reaches a roadmap.",
  },
  {
    name: "The report you rebuild every Monday",
    body: "Pull the same three sources, join them the same way, send the same email. It takes you forty minutes a week and it takes a workflow two seconds.",
  },
  {
    name: "The inbox triage",
    body: "Read overnight mail, group it, and surface the three things that actually need an answer before you open your laptop.",
  },
  {
    name: "The thing you check by hand",
    body: "A page, a feed, a spreadsheet, a queue — anything you open every morning to see whether it changed. That is a schedule, and a schedule is cheaper than your attention.",
  },
] as const

export default function EmployeesPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">For employees</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              You already know AI can research. Almost nobody has had it do the work.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Everyone in the building has asked an assistant to summarise a document or draft a
              reply. Hardly anyone has had it build the thing that does that every morning without
              being asked — not for want of ideas, but because acting on one means getting IT to
              approve a tool and finance to approve a budget. Most ideas do not survive that.
            </p>
            <p className="mt-4 text-lg text-muted-foreground text-pretty">
              SproutOS is small enough to skip both conversations.
            </p>
            <div className="mt-8">
              <LoginWithGitHubButton size="xl" />
            </div>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">The three usual blockers</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Too cheap to need approval. Too simple to need a developer.
            </h2>
          </Reveal>
          <dl className="mt-12 grid gap-8 md:grid-cols-3 lg:gap-10">
            {ANSWERS.map((answer, i) => (
              <Reveal
                key={answer.label}
                delay={i * 80}
                className="border-t-2 border-primary/40 pt-5"
              >
                <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                  {answer.label}
                </dt>
                <dd className="mt-3 text-sm text-muted-foreground text-pretty">{answer.body}</dd>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">What a budget of cents buys</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              The work that is too small to ask anyone for.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              Automation platforms bill by the seat, the task, or the month — and every one of them
              charges you while your automation sits there doing nothing. Ours sleeps when there is
              no work, so a job that runs for two seconds a day costs what two seconds a day is
              worth.
            </p>
          </Reveal>

          <ul className="mt-12 grid gap-5 sm:grid-cols-2">
            {EXAMPLES.map((example, i) => (
              <RevealItem
                key={example.name}
                delay={i * 70}
                className="h-full rounded-2xl border rule-soft bg-card/60 p-6"
              >
                <h3 className="font-display text-base font-semibold tracking-tight text-balance">
                  {example.name}
                </h3>
                <p className="mt-3 text-sm text-muted-foreground text-pretty">{example.body}</p>
              </RevealItem>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page grid gap-10 sm:grid-cols-2 lg:gap-14">
          <Reveal className="border-l-2 border-primary/40 pl-6">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              A retrieval pipeline for your team
            </h2>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              Connect a data source, describe the questions people actually ask and what a good
              answer looks like, and Sprout's community skills build the pipeline — knowledge graph,
              tuned embeddings, deliberate ingestion — for that one use case.
            </p>
          </Reveal>

          <Reveal delay={80} className="border-l-2 border-primary/40 pl-6">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Private by construction
            </h2>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              It is your code, in your project, talking to your account and your database. The cheap
              version of this elsewhere is someone else's cloud reading your company's mail.
            </p>
          </Reveal>
        </div>

        <Reveal delay={120} className="container-page mt-14">
          <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
            If someone is going to ask you what IT thinks, the answer is on the{" "}
            <Link href="/business/it" className="text-primary hover:underline">
              page written for them
            </Link>
            .
          </p>
        </Reveal>
      </section>
    </>
  )
}
