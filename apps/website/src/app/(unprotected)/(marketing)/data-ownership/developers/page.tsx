import { Reveal } from "@ui/spa-shared/reveal"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "SproutOS for developers — SproutOS",
  description:
    "Sign users in with SproutOS OAuth and give each of them a database of their own. " +
    "Authorization Code with PKCE, an optional database:create scope, and per-grant credentials.",
  alternates: { canonical: "/data-ownership/developers" },
}

const WHY = [
  {
    title: "You stop being the custodian",
    body: "The rows live in a database the user pays for and controls. A breach of your servers is not a breach of their history, and a subject access request is a link to their own database rather than an engineering week.",
  },
  {
    title: "Your storage bill stops tracking your signups",
    body: "Per-user data is on the user's account, metered to them. Growth costs you compute, not a storage line that grows forever whether or not the user ever comes back.",
  },
  {
    title: "You compete on the app, not on the moat",
    body: "Users who can leave easily are users who stayed because they wanted to. That is a harder bar and a much better signal than a retention number propped up by an export button nobody can use.",
  },
] as const

const FLOW = [
  {
    step: "1",
    title: "Register a client",
    body: "Exact HTTPS redirect URIs, Authorization Code with PKCE. Public clients use S256 and ship no secret.",
  },
  {
    step: "2",
    title: "Send them to authorize",
    body: "client_id, redirect_uri, response_type=code, code_challenge, code_challenge_method=S256, state, and the scopes you need. Validate state before exchanging the code.",
  },
  {
    step: "3",
    title: "Ask for a database, optionally",
    body: "database:create spends the user's SproutOS credit. Add intent=create_personal_database and the consent screen explains the billing. The user can decline that permission and still sign in.",
  },
  {
    step: "4",
    title: "Hold a credential you do not own",
    body: "Database credentials belong to the grant that created them. Connection URIs are returned once. Rotating your application credential does not touch the user's, or another application's.",
  },
  {
    step: "5",
    title: "Let them revoke you",
    body: "From their settings, without asking you. Revocation stops new API calls and revokes the credentials that grant owns — and whatever the user chooses to keep stays theirs.",
  },
] as const

export default function DevelopersPage() {
  return (
    <>
      <section className="relative overflow-hidden py-20 sm:py-28">
        <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">For developers</p>
            <h1 className="font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
              Ship an app that never holds your users' data.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground text-pretty">
              Sign people in with SproutOS and hand each of them a Postgres database of their own.
              You get the app; they get the rows. It is the same amount of work as any other OAuth
              integration, and it is the one thing that actually lowers switching costs in consumer
              software rather than promising to.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/oauth-applications"
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/70 hover:bg-primary/12"
              >
                Read the OAuth guide
                <span aria-hidden="true">→</span>
              </Link>
              <Link
                href="/docs/developers"
                className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                All developer docs
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="eyebrow mb-4">Why you would want this</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Holding everybody's data is a liability you have been taught to call an asset.
            </h2>
          </Reveal>
          <dl className="mt-12 grid gap-8 md:grid-cols-3 lg:gap-10">
            {WHY.map((item, i) => (
              <Reveal key={item.title} delay={i * 80} className="border-t-2 border-primary/40 pt-5">
                <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                  {item.title}
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
            <p className="eyebrow mb-4">The integration</p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Authorization Code with PKCE, and one extra scope.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              SproutOS publishes an authorization server metadata document, so a conforming client
              can discover the endpoints rather than hard-code them. If you have integrated an OAuth
              provider before, there is exactly one new idea here — the database scope.
            </p>
          </Reveal>

          <ol className="mt-12 flex flex-col gap-px overflow-hidden rounded-2xl border rule-soft bg-border/60">
            {FLOW.map((row, i) => (
              <Reveal key={row.step} delay={i * 60}>
                <li className="grid gap-3 bg-card/70 p-7 sm:grid-cols-[3rem_14rem_1fr] sm:gap-6">
                  <span className="tnum font-mono text-sm text-primary">{row.step}</span>
                  <p className="font-display text-base font-semibold tracking-tight">{row.title}</p>
                  <p className="text-sm text-muted-foreground text-pretty">{row.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>

          <Reveal delay={100}>
            <p className="mt-8 max-w-3xl text-sm text-muted-foreground text-pretty">
              A grant may include database creation even when the account has no credit — the
              creation request returns HTTP 402 until there is some. Handle that case and the rest
              is an ordinary token exchange. The full reference is in the{" "}
              <Link href="/docs/oauth-applications" className="text-primary hover:underline">
                OAuth applications guide
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t rule-soft py-20 sm:py-28">
        <div className="container-page">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
              Switching costs fall when enough apps agree to stop holding the data.
            </h2>
            <p className="mt-5 text-muted-foreground text-pretty">
              One app doing this is a nice privacy story. Enough apps doing it is a market where a
              better product can actually win — and where your users' history is a reason to try you
              rather than a reason they cannot.
            </p>
            <Link
              href="/docs/developers"
              className="mt-8 inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/70 hover:bg-primary/12"
            >
              Start with the developer docs
              <span aria-hidden="true">→</span>
            </Link>
          </Reveal>
        </div>
      </section>
    </>
  )
}
