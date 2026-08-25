import Link from "next/link"
import { Reveal } from "@ui/spa-shared/reveal"

function Connector() {
  return (
    <div aria-hidden="true" className="flex flex-col items-center py-2">
      <span className="h-6 w-px bg-border" />
      <span className="-mt-1 text-xs text-muted-foreground">▾</span>
    </div>
  )
}

/**
 * The path from someone else's app to your own, in the words a person would use.
 */
function PersonalizeFlow() {
  return (
    <div className="w-full rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="rounded-xl border rule-soft bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">From the store</p>
        <p className="font-display text-base font-semibold tracking-tight">Recipe Box</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Open source. Already works. 4,100 people run it.
        </p>
      </div>

      <Connector />

      <div className="rounded-xl border border-primary/35 bg-primary/8 px-5 py-4">
        <p className="eyebrow mb-2">You say</p>
        <p className="font-mono text-sm leading-relaxed text-foreground">
          “Add a shopping list that groups everything by supermarket aisle.”
        </p>
      </div>

      <Connector />

      <div className="rounded-xl border border-primary/45 bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">Yours</p>
        <p className="font-display text-base font-semibold tracking-tight text-primary">
          Your Recipe Box
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your changes, your recipes, your database.
        </p>
      </div>

      {/*
        Upkeep is a step in the flow, not a footnote under it.

        This was a paragraph below a divider, which is where a reader puts things that happened
        once. It is the opposite: the loop is the part that never stops, and it is most of why
        forking here differs from clicking "Fork" on GitHub. So it is drawn — an arrow leaving the
        original, curving past everything the customer changed, and arriving back at their copy.
      */}
      <div className="mt-5 flex items-center gap-3 rounded-xl border border-dashed rule-soft px-5 py-4">
        <UpkeepLoop />
        <p className="text-xs text-muted-foreground text-pretty">
          <span className="font-medium text-foreground">And it keeps up.</span> When the original
          gets a fix or a new feature, it arrives in your copy — your changes stay put.
        </p>
      </div>
    </div>
  )
}

/**
 * The upkeep loop: out of the original, around, and back into your copy.
 *
 * `currentColor` throughout so it takes the surrounding text colour in either theme, and the
 * arrowhead is a `marker` on the path rather than a second shape to keep aligned with it. Marked
 * `aria-hidden` because the sentence beside it already says this — a screen reader announcing
 * "loop" adds nothing.
 */
function UpkeepLoop() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 40 40"
      className="size-9 shrink-0 text-primary"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <defs>
        <marker
          id="upkeep-arrow"
          viewBox="0 0 8 8"
          refX="6"
          refY="4"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,1 L6,4 L0,7 z" fill="currentColor" stroke="none" />
        </marker>
      </defs>
      {/* Three-quarters of a circle, so the gap reads as motion rather than a closed ring. */}
      <path d="M32 14 A14 14 0 1 0 34 24" markerEnd="url(#upkeep-arrow)" />
      <circle cx="20" cy="20" r="3.2" className="text-primary" />
    </svg>
  )
}

export function AppStore() {
  return (
    <section id="app-store" className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
        <Reveal>
          <p className="eyebrow mb-4">The app store</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            Start from an app that already works. Then make it yours.
          </h2>
          <p className="mt-5 text-muted-foreground text-pretty">
            The hard part of having your own app is building the first version. Our store hands you
            that part already done — an Android store and a web store of open source apps other
            people already use. Personalizing one is a sentence, not a project.
          </p>
          <p className="mt-4 text-muted-foreground text-pretty">
            And your copy doesn't go stale. SproutOS keeps it current with the original, so fixes
            and new features arrive without undoing anything you changed. That upkeep can run on the
            Claude Code subscription you already pay for, your own API key, or an in-house model.
          </p>

          {/*
            The section described a store and offered no way to open it. `/store` renders for a
            signed-out visitor — it is one of `SHARED_ROUTES` — so this needs no account and is not
            a sign-up wall wearing a browse button.
          */}
          <Link
            href="/store"
            className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/70 hover:bg-primary/12"
          >
            Browse the store
            <span aria-hidden="true">→</span>
          </Link>
        </Reveal>

        <Reveal delay={100} className="flex justify-center lg:justify-end">
          <PersonalizeFlow />
        </Reveal>
      </div>
    </section>
  )
}
