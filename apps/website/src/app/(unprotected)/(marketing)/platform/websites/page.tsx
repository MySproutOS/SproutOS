import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"
import { CostCard, PRICE_DISCLOSURE } from "../_components/cost-card"

export const metadata: Metadata = {
  title: "Websites — SproutOS",
  description:
    "Sites that run code — sessions, forms, a database call on page load — hosted for cents a " +
    "month, with the source open and nothing holding it hostage.",
  alternates: { canonical: "/platform/websites" },
}

const VS_BUILDERS = [
  {
    label: "Like Lovable and OpenAI Sites",
    body: "You describe the site and it gets built and deployed. Same shape of product, same absence of a build step you have to understand.",
  },
  {
    label: "Minus the trapdoor",
    body: "The code stays open source and lives in your own repository. The infrastructure has no way to hold it hostage, because you can take the repository and run it anywhere.",
  },
  {
    label: "With a real backend behind it",
    body: "Auth, a Postgres database, background jobs and search — not a static page with a form that emails you. That is the part these tools usually leave to somebody else.",
  },
] as const

export default function WebsitesPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Websites</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              A site that runs code, not just files.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Anything past a static page needs a server somewhere: sessions, forms, a database call
              on page load. The two ordinary ways to have one are to rent a platform seat or to rent
              a box — and both of them charge you for the twenty-three hours a day nobody visits.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Priced both ways</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Somewhere for the site to run.
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <Reveal className="h-full">
              <CostCard
                eyebrow="Server-based website"
                title="A site that runs code, not just files"
                body="Anything past a static page needs a server somewhere: sessions, forms, a database call on page load. The two ordinary ways to have one are to rent a platform seat or to rent a box."
                ours={{ amount: "$0.01", unit: "/mo", note: "1,000 visitors" }}
                theirs={[
                  {
                    label: "Vercel Pro",
                    detail: "$20/mo platform fee, plus $20 for each extra person who can deploy",
                    monthly: 20,
                  },
                  {
                    label: "The cheapest EC2 that can serve it",
                    detail: "t4g.nano + 8 GB disk + a public IPv4, on all month",
                    monthly: 7.36,
                  },
                ]}
                footnote="Vercel's fee covers one deploying seat and $20 of usage credit; read-only viewers are free, but every additional person who can ship is another $20, so the bill tracks the size of the team rather than the size of the app. The EC2 box is cheaper and is yours to patch, monitor and put TLS on."
              />
            </Reveal>

            <Reveal delay={80} className="h-full">
              <div className="flex h-full flex-col rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
                <p className="eyebrow mb-4">Compared with the site builders</p>
                <h3 className="font-display text-xl font-semibold tracking-tight text-balance">
                  Like Lovable, minus the trapdoor.
                </h3>
                <dl className="mt-6 flex flex-col gap-5">
                  {VS_BUILDERS.map((row) => (
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
        <div className="container-page grid gap-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-start lg:gap-20">
          <Reveal>
            <p className="eyebrow mb-4">Worked example</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Search your iMessage history and actually find things.
            </h2>
            <p className="mt-5 text-muted-foreground text-pretty">
              iMessage search has a deservedly bad reputation. Sprout's community skills encode how
              top startups actually build retrieval — fine-tuned embeddings, a knowledge graph
              alongside the vector store, and real judgment about what to ingest — not a single
              embedding model pointed at a pile of text.
            </p>
            <p className="mt-4 text-muted-foreground text-pretty">
              Sprout builds the search site and stands up the backend services behind it, cheaply,
              and the results are better.
            </p>
            <a
              href="https://blog.bytebytego.com/p/why-doordash-instacart-and-uber-eats"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-6 inline-flex items-center gap-1.5 rounded-md font-mono text-xs text-primary underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              How DoorDash, Instacart and Uber Eats build retrieval ↗
            </a>
          </Reveal>

          <Reveal delay={100} className="rounded-2xl border rule-soft bg-card/60 p-7 sm:p-9">
            <p className="eyebrow mb-4">Getting one deployed</p>
            <p className="text-muted-foreground text-pretty">
              Start from something in the store and change it, or point SproutOS at a repository you
              already have. Deployments come from a GitHub Action you add to your own repository,
              authenticated by OIDC, so there is no token of ours living in your CI.
            </p>
            <div className="mt-6 flex flex-wrap gap-4">
              <Link
                href="/docs/github-action"
                className="text-sm font-medium text-primary transition-colors hover:underline"
              >
                The deploy action →
              </Link>
              <Link
                href="/docs/connecting"
                className="text-sm font-medium text-primary transition-colors hover:underline"
              >
                Connecting a repository →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <Reveal className="container-page flex justify-center">
          <LoginWithGitHubButton size="xl" variant="outline" />
        </Reveal>
      </section>
    </>
  )
}
