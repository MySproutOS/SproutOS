import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"
import { CostCalculator } from "./_components/cost-calculator"

export const metadata: Metadata = {
  title: "SproutOS for IT — SproutOS",
  description:
    "Small enough to approve without a procurement conversation, and nothing for your team to " +
    "run or support. Every automation is code in the company's own repository with a run log.",
  alternates: { canonical: "/business/it" },
}

const ANSWERS = [
  {
    label: "You can see exactly what it does",
    body: "Every automation is code in a repository you own, with a plain-language description of what it touches and a log of every run. Review it like any other pull request, or don't — it is there either way.",
  },
  {
    label: "There is nothing for you to run",
    body: "No box to patch, no n8n server to keep upright, no upgrade that breaks a credential at eleven at night. The failure mode of this tool is not a machine your team is responsible for.",
  },
  {
    label: "There is nothing for you to support",
    body: "People describe what they want in their own words and it runs. The tickets you would normally get — build me this, fix my script, why is the runner down — mostly do not get raised.",
  },
  {
    label: "Access is scoped and revocable",
    body: "Each project's credentials belong to that project. Nobody in the company ever holds a cloud credential, and revoking a grant revokes what it created.",
  },
] as const

export default function ItPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">For IT</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              Under every approval threshold anyone has ever written down.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              The reason your people keep asking for automation tools and then dropping it is that
              the smallest useful plan costs more than the idea is obviously worth, so it needs a
              budget line, so it needs you. A department's worth of automations here bills in cents
              — which means the conversation that normally kills the idea never starts.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Cost calculator</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Work out which side of the threshold this falls on.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              The difference is not a discount we are funding. It is that everything on SproutOS
              sleeps when nothing is happening, and a small internal tool is idle almost all of the
              time — whereas a rented instance is billed for the hour it exists, not the hour it is
              used.
            </p>
          </Reveal>

          <Reveal delay={100} className="mt-10">
            <CostCalculator />
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">What you are actually approving</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              A prepaid balance, and code in your own repositories.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              There is no seat, no plan and no minimum. Credit is bought up front and drawn down by
              usage; when it runs out, new work is refused rather than quietly billed. That is a
              spend cap by construction, which is usually the thing an approver actually wants and
              rarely the thing they are offered.
            </p>
          </Reveal>

          <dl className="mt-12 grid gap-8 sm:grid-cols-2 lg:gap-10">
            {ANSWERS.map((answer, i) => (
              <Reveal
                key={answer.label}
                delay={i * 70}
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
        <Reveal className="container-page flex flex-col items-center text-center">
          <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Your team stops needing technical resources to deploy the software they already know
            they want.
          </h2>
          <p className="mt-5 max-w-xl text-muted-foreground text-pretty">
            The same argument, written for the people who will actually be using it, is on the{" "}
            <Link href="/business/employees" className="text-primary hover:underline">
              employees page
            </Link>
            .
          </p>
          <div className="mt-9">
            <LoginWithGitHubButton size="xl">Get your team early access</LoginWithGitHubButton>
          </div>
        </Reveal>
      </section>
    </>
  )
}
