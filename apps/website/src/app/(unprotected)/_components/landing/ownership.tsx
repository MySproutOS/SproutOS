import { LoginWithGitHubButton } from "@website/components/auth/login-with-github-button"
import { Reveal } from "@ui/spa-shared/reveal"

const POINTS = [
  {
    title: "A database per person",
    body: "Because databases are cheap to spin up, an app can sign you in with SproutOS OAuth and hand you a database of your own. Privacy stops being a policy and starts being an architecture.",
  },
  {
    title: "No fork required to own it",
    body: "If the original app supports personalized databases, your data is yours without maintaining any code at all.",
  },
  {
    title: "Leaving is a prompt, not a project",
    body: "Point a coding agent at your database and move to another app in the same category. Low switching costs are what let a diverse app ecosystem exist at all.",
  },
] as const

export function Ownership() {
  return (
    <section id="ownership" className="relative overflow-hidden border-t rule-soft py-20 sm:py-28">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[28rem] w-[52rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/6 blur-[120px]"
      />
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">Data ownership</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Your data sits in a database with your name on it.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            Data ownership and personalization are the two things SproutOS is actually built around.
            Everything else is plumbing in service of them.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border rule-soft bg-border/60 md:grid-cols-3">
          {POINTS.map((point, i) => (
            <Reveal key={point.title} delay={i * 80} className="bg-card/70 p-7">
              <h3 className="font-display text-lg font-semibold tracking-tight">{point.title}</h3>
              <p className="mt-3 text-sm text-muted-foreground text-pretty">{point.body}</p>
            </Reveal>
          ))}
        </div>

        <Reveal delay={120} className="mt-12 flex justify-center">
          <LoginWithGitHubButton size="xl" variant="outline" />
        </Reveal>
      </div>
    </section>
  )
}
