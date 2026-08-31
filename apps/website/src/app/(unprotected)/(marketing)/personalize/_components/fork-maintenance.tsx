import { Reveal } from "@ui/spa-shared/reveal"

/*
  Fork maintenance, drawn.

  This is the part of the product that is hardest to believe and easiest to state badly. "We keep
  your fork up to date" is what everyone says; what matters is what happens on the day upstream and
  your change touch the same lines, because that is the day a naive answer either loses your change
  or stops updating forever.

  So the diagram shows the whole loop including its unhappy path, and the numbers under it are the
  real policy from `lib/typescript/dao/src/upstreamSyncRun/policy.ts` rather than reassurance.
*/

const OUTCOMES = [
  {
    outcome: "Up to date",
    body: "Nothing changed upstream. The run costs a few seconds and stops.",
  },
  {
    outcome: "Merged",
    body: "Upstream moved, your files were not in the way. The change lands in your copy and your project redeploys.",
  },
  {
    outcome: "Conflict",
    body: "Upstream and you changed the same lines. You get a pull request to resolve — not a silent overwrite, and not a stalled fork.",
  },
] as const

const POLICY = [
  {
    label: "You pick the cadence",
    body: "On every upstream release tag, or daily, weekly, or monthly. A missed interval stays due, so a quiet week catches up rather than skipping.",
  },
  {
    label: "A conflict is not a failure",
    body: "It is the normal state of a fork somebody is actually using. Only genuine failures count against the pause.",
  },
  {
    label: "Five failures in a row pauses it",
    body: "Every run costs money — tokens on a metered key, or wall-clock on a runner. A fork whose upstream has diverged past reconciliation would otherwise fail identically every night forever.",
  },
  {
    label: "It runs on your model",
    body: "The Claude Code subscription you already pay for, your own API key, or an in-house host. The upkeep is ours; the tokens can be yours.",
  },
] as const

function Box({
  eyebrow,
  title,
  body,
  tone = "default",
}: {
  eyebrow: string
  title: string
  body: string
  tone?: "default" | "primary"
}) {
  return (
    <div
      className={`rounded-xl border px-5 py-4 ${
        tone === "primary" ? "border-primary/45 bg-primary/8" : "rule-soft bg-background/50"
      }`}
    >
      <p className="eyebrow mb-1.5">{eyebrow}</p>
      <p className="font-display text-base font-semibold tracking-tight">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground text-pretty">{body}</p>
    </div>
  )
}

/**
 * The vertical rail with a label on it, drawn rather than described, so the reader can see that the
 * two inputs meet at one place.
 */
function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2 pl-5">
      <span aria-hidden="true" className="h-8 w-px bg-border" />
      <span className="font-mono text-[0.6875rem] text-muted-foreground">{label}</span>
    </div>
  )
}

export function ForkMaintenance() {
  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page">
        <Reveal className="max-w-3xl">
          <p className="eyebrow mb-4">Fork maintenance</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Somebody else still maintains the app. You maintain the few details that are yours.
          </h2>
          <p className="mt-5 text-lg text-muted-foreground text-pretty">
            That is the whole bargain. A fork on GitHub is a copy that starts rotting the moment you
            make it; the reason personalizing an app is normally a bad idea is that you have just
            volunteered to maintain all of it. SproutOS runs the reconciliation for you, so the
            surface you own stays the size of the change you asked for.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-10 lg:grid-cols-[24rem_1fr] lg:gap-16">
          <Reveal>
            <div className="rounded-2xl border rule-soft bg-card/60 p-6 sm:p-7">
              <Box
                eyebrow="Upstream"
                title="The original app"
                body="Its maintainers keep shipping fixes and features, the way they already were."
              />
              <Arrow label="new commits" />
              <Box
                eyebrow="Your copy"
                title="Your personalization"
                body="The handful of changes you asked for, on top."
                tone="primary"
              />
              <Arrow label="on your cadence, SproutOS merges the two" />
              <div className="rounded-xl border border-dashed rule-soft px-5 py-4">
                <p className="eyebrow mb-3">One of three things happens</p>
                <ul className="flex flex-col gap-3">
                  {OUTCOMES.map((row) => (
                    <li key={row.outcome}>
                      <p className="text-sm font-medium text-foreground">{row.outcome}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{row.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <dl className="grid gap-8 sm:grid-cols-2">
              {POLICY.map((item) => (
                <div key={item.label} className="border-t-2 border-primary/40 pt-5">
                  <dt className="font-display text-lg font-semibold tracking-tight text-balance">
                    {item.label}
                  </dt>
                  <dd className="mt-3 text-sm text-muted-foreground text-pretty">{item.body}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
