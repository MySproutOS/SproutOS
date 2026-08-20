import { SproutMark } from "@website/components/icons"
import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t rule-soft py-24 sm:py-32">
      <div aria-hidden="true" className="soil-grid pointer-events-none absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-14rem] left-1/2 -z-10 h-[26rem] w-[46rem] -translate-x-1/2 rounded-full bg-primary/12 blur-[120px]"
      />

      <Reveal className="container-page flex flex-col items-center text-center">
        <SproutMark className="mb-7 size-9 text-primary" />
        <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.75rem] sm:leading-[1.08]">
          Build the thing. Keep the data. Pay in cents.
        </h2>
        <p className="mt-5 max-w-xl text-muted-foreground text-pretty">
          Start from an app that already works, say what you want changed, and keep the database it
          runs on.
        </p>
        <div className="mt-9">
          <LoginWithGitHubButton size="xl" />
        </div>

        <p className="mt-6 font-mono text-xs text-muted-foreground">
          Sign in with GitHub to fork your first project
        </p>
      </Reveal>
    </section>
  )
}
