import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "The AI agent — SproutOS",
  description:
    "One agent implements the change you asked for and then keeps your fork current with " +
    "upstream. Runs on your Claude Code subscription, your own API key, or an in-house model.",
  alternates: { canonical: "/platform/ai-agent" },
}

const BUILDS = [
  {
    label: "It picks the pieces",
    body: "You do not have to know whether your idea needs a queue, a search index or just a table. The agent decides what the app needs and wires it together, so the vocabulary of the platform never becomes your problem.",
  },
  {
    label: "It works in your repository",
    body: "Changes are commits on a branch of a repository you own, with a plain-language description of what they touch. Review them like any other pull request, or don't — they are there either way.",
  },
  {
    label: "It gets a real environment",
    body: "The agent works against its own branch of your Postgres, copy-on-write, with credentials scoped to that branch alone. It can run the thing it just wrote instead of guessing whether it works.",
  },
] as const

const MAINTAINS = [
  {
    label: "On a cadence you pick",
    body: "Every upstream release tag, or daily, weekly, or monthly. A missed interval stays due, so downtime catches up rather than silently skipping a week.",
  },
  {
    label: "A conflict is not a failure",
    body: "When upstream and your change touch the same lines, you get a pull request to resolve. That is the normal state of a fork somebody is using, and it does not count against anything.",
  },
  {
    label: "Five real failures in a row pauses it",
    body: "Every run costs money, so a fork whose upstream has diverged past reconciliation stops rather than failing identically every night forever. You are told, and you can restart it.",
  },
] as const

export default function AiAgentPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">The AI agent</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              It builds the change. Then it keeps doing the boring half forever.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Plenty of things will write you an app. The part nobody wants is what happens
              afterwards — the upstream release you did not notice, the dependency bump, the merge
              you keep meaning to do. That is the work the agent is really for, and it is the reason
              personalizing an app here is not the same as forking one on GitHub.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Implementing</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              You describe the outcome. It decides what the platform has to do.
            </h2>
          </Reveal>
          <dl className="mt-12 grid gap-8 md:grid-cols-3 lg:gap-10">
            {BUILDS.map((item, i) => (
              <Reveal key={item.label} delay={i * 80} className="border-t-2 border-primary/40 pt-5">
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
            <p className="eyebrow mb-4">Maintaining</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Upkeep is a loop, not a favour it does once.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              A fork starts rotting the moment you make it. SproutOS merges upstream into your copy
              on a schedule and tells you which of three things happened — nothing to do, it merged,
              or you and upstream disagree and here is a pull request.
            </p>
          </Reveal>
          <dl className="mt-12 grid gap-8 md:grid-cols-3 lg:gap-10">
            {MAINTAINS.map((item, i) => (
              <Reveal key={item.label} delay={i * 80} className="border-l-2 border-primary/40 pl-6">
                <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                  {item.label}
                </dt>
                <dd className="mt-3 text-sm text-muted-foreground text-pretty">{item.body}</dd>
              </Reveal>
            ))}
          </dl>

          <Reveal delay={120}>
            <p className="mt-8 max-w-3xl text-sm text-muted-foreground text-pretty">
              The same loop, drawn end to end, is on the{" "}
              <Link href="/personalize" className="text-primary hover:underline">
                personalization page
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page grid gap-6 lg:grid-cols-2">
          <Reveal className="h-full">
            <div className="h-full rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
              <p className="eyebrow mb-4">Bring your own model</p>
              <h2 className="font-display text-xl font-semibold tracking-tight text-balance">
                It can run on tokens you already pay for.
              </h2>
              <p className="mt-4 text-muted-foreground text-pretty">
                The Claude Code subscription you have, an API key of your own, or a model hosted
                inside your company. Upkeep is not a reason to buy a second AI budget, and a team
                that is not allowed to send code to a third party can point this at their own host.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80} className="h-full">
            <div className="h-full rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
              <p className="eyebrow mb-4">Or ours, at cost</p>
              <h2 className="font-display text-xl font-semibold tracking-tight text-balance">
                Platform tokens are passed through.
              </h2>
              <p className="mt-4 text-muted-foreground text-pretty">
                If you use the model we provide, the tokens are billed at what they cost us — there
                is no platform fee on top of AI usage, and the agent's own running time is not
                charged at all. What you pay for is the work it causes, not the fact that it thought
                about it.
              </p>
              <Link
                href="/docs/billing"
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:underline"
              >
                How billing works <span aria-hidden="true">→</span>
              </Link>
            </div>
          </Reveal>
        </div>

        <Reveal delay={120} className="container-page mt-12 flex justify-center">
          <LoginWithGitHubButton size="xl" variant="outline" />
        </Reveal>
      </section>
    </>
  )
}
