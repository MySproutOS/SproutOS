import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"

/*
  The section opens on the gap rather than on the product.

  Everybody in the building has already used Claude to research something. Almost nobody has used
  it to *automate* something, and the reason is not that they lack the idea — it is that acting on
  the idea means asking IT for approval and finance for a line item, which is where the idea dies.
  The three points below are the three answers to that, in the order the objection actually
  arrives: IT can see what it does, it costs less than a cup of coffee, and nobody has to run
  anything.
*/

const ANSWERS = [
  {
    label: "IT can see exactly what it does",
    body:
      "Every automation is code in your own repository, with a plain-language description of what " +
      "it touches and a log of every run. Review it like any other pull request, or don't — it is " +
      "there either way.",
  },
  {
    label: "Under $1 a month",
    body:
      "Not a seat, not a plan, not a minimum. A department's worth of automations bills in cents, " +
      "which is small enough that it never becomes a procurement conversation.",
  },
  {
    label: "Nobody has to run it",
    body:
      "No engineer to spare, no IT team keeping an n8n box patched and upright. Your people " +
      "describe what they want and it is running in five minutes.",
  },
] as const

export function ForBusiness() {
  return (
    <section id="business" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">For businesses & consultancies</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Your team already knows AI can research. They don't know it can do the work.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            Everyone has asked Claude to summarise a document or draft a reply. Hardly anyone has
            had it build the thing that does that every morning without being asked — not for want
            of ideas, but because acting on one means getting IT to approve a tool and finance to
            approve a budget. Most ideas do not survive that.
          </p>
          <p className="mt-4 text-lg text-muted-foreground text-pretty">
            SproutOS is small enough to skip both conversations.
          </p>
        </Reveal>

        <dl className="mt-12 grid gap-8 sm:grid-cols-3 lg:gap-10">
          {ANSWERS.map((answer, i) => (
            <Reveal key={answer.label} delay={i * 80} className="border-t-2 border-primary/40 pt-5">
              <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                {answer.label}
              </dt>
              <dd className="mt-3 text-sm text-muted-foreground text-pretty">{answer.body}</dd>
            </Reveal>
          ))}
        </dl>

        <div className="mt-16 grid gap-10 sm:grid-cols-2 lg:gap-14">
          <Reveal className="border-l-2 border-primary/40 pl-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">
              Customer success, unblocked
            </h3>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              CSMs are stretched thin and want follow-ups that fire on their own — and cancel
              themselves when a client has already replied. That's an afternoon on SproutOS, not a
              roadmap item.
            </p>
          </Reveal>

          <Reveal delay={80} className="border-l-2 border-primary/40 pl-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">
              A retrieval pipeline per department
            </h3>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              Connect a data source, describe the questions people actually ask and what a good
              answer looks like, and Sprout's community skills build the pipeline — knowledge graph,
              tuned embeddings, deliberate ingestion — for that one use case.
            </p>
          </Reveal>
        </div>

        <Reveal
          delay={140}
          className="mt-14 rounded-2xl border rule-soft bg-card/60 px-7 py-8 sm:px-10"
        >
          <p className="max-w-2xl text-lg text-balance">
            You stop needing technical resources to deploy the software your team already knows it
            wants.
          </p>
          <div className="mt-6">
            <LoginWithGitHubButton size="xl">Get your team early access</LoginWithGitHubButton>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
