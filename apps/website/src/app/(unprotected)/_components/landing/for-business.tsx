import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"

export function ForBusiness() {
  return (
    <section id="business" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">For businesses & consultancies</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            The tool your team needs shouldn't take a quarter to approve.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            SproutOS lets an employee describe an automation in a few sentences and have it running,
            without booking engineering time or opening a ticket.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:gap-14">
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
