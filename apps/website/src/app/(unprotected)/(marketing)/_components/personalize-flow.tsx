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
 *
 * The app here is an illustration and is labelled as one. It used to claim "4,100 people run it",
 * which was invented — and an invented number on the one page arguing that you should trust us with
 * your data is a bad trade for a little social proof. The real catalogue is on `/store`.
 */
export function PersonalizeFlow() {
  return (
    <div className="w-full rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="rounded-xl border rule-soft bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">From the store — for example</p>
        <p className="font-display text-base font-semibold tracking-tight">Recipe Box</p>
        <p className="mt-1 text-sm text-muted-foreground">Open source. Already works.</p>
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
 * `currentColor` throughout so it takes the surrounding text colour, and the arrowhead is a `marker`
 * on the path rather than a second shape to keep aligned with it. Marked `aria-hidden` because the
 * sentence beside it already says this — a screen reader announcing "loop" adds nothing.
 */
export function UpkeepLoop() {
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
