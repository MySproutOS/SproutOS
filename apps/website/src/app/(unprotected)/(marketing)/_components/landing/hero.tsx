import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import Link from "next/link"
import { CostReceipt } from "./cost-receipt"
import { Reveal } from "@ui/spa-shared/reveal"

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-16 pb-20 sm:pt-24 sm:pb-28">
      <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />

      <div className="container-page">
        <Reveal>
          <p className="eyebrow mb-5">Personalize · Own your data · Deploy for cents</p>
          <h1 className="max-w-5xl font-display text-[2.75rem] leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl lg:text-[4.5rem]">
            Start from an app that works.
            <br />
            <span className="text-primary">Make it yours. Own the data.</span>
          </h1>
        </Reveal>

        <div className="mt-14 grid gap-12 lg:grid-cols-[1fr_26rem] lg:items-start lg:gap-16">
          <Reveal delay={80} className="flex flex-col items-start">
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              Pick an open source app from our store, say in a sentence what you want changed, and
              SproutOS deploys it for you — the site, the automations, and a database that belongs
              to you. You write no code, and it runs for a few cents a month.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <LoginWithGitHubButton size="xl" />
              <Link
                href="/personalize"
                className="rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                See how it works
              </Link>
            </div>

            <p className="mt-5 font-mono text-xs text-muted-foreground">
              Sign in with GitHub · <span className="tnum text-primary">$1</span> minimum · No card
              to look around
            </p>

            <p className="mt-3 font-mono text-xs text-muted-foreground">
              No code · Your own database · Nothing to lock you in
            </p>
          </Reveal>

          <Reveal delay={160}>
            <CostReceipt />
          </Reveal>
        </div>
      </div>
    </section>
  )
}
