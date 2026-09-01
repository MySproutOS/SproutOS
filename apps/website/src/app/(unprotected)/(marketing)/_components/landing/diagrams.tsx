import { UpkeepLoop } from "../personalize-flow"

/*
  Diagrams that each carry an argument the prose cannot.

  House style on this site is bordered blocks and 1px rails rather than illustration — see
  `personalize/_components/fork-maintenance.tsx`, which established it. Amber is money and only
  money (`theme.css`), so the only amber here is on the two figures in `IdleCost`.
*/

function Rail({ height = "h-7" }: { height?: string }) {
  return (
    <div aria-hidden="true" className="flex justify-center">
      <span className={`w-px ${height} bg-border`} />
    </div>
  )
}

/**
 * Many apps, one database, one question.
 *
 * The question is the point. "Query across your data" is a capability nobody pictures; *did I hit
 * my runs on the weeks I slept badly and the calendar was full* is a question a person has actually
 * had — and it is unanswerable today precisely because it needs three vendors' data at once.
 */
export function OwnershipDiagram() {
  return (
    <div className="rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <ul className="grid grid-cols-3 gap-2.5">
        {["Fitness", "Health", "Calendar"].map((source) => (
          <li
            key={source}
            className="rounded-lg border rule-soft bg-background/50 px-2 py-2.5 text-center text-sm"
          >
            {source}
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-3 gap-2.5">
        <Rail />
        <Rail />
        <Rail />
      </div>

      <div className="rounded-xl border border-primary/45 bg-primary/8 p-5 text-center">
        <p className="eyebrow mb-1.5">One Postgres</p>
        <p className="font-display text-[1.0625rem] font-semibold tracking-tight text-primary">
          Your database
        </p>
        <p className="mt-1.5 font-mono text-xs text-muted-foreground">
          you hold the connection string
        </p>
      </div>

      <Rail />

      <div className="rounded-xl border border-dashed rule-soft p-5">
        <p className="eyebrow mb-2.5">One question, three apps</p>
        <p className="font-mono text-[0.8125rem] leading-relaxed text-foreground text-pretty">
          “On the weeks I slept under seven hours and the calendar went over 30 hours of meetings —
          did I still hit my runs, and is the March race realistic?”
        </p>
        <p className="mt-3 text-xs text-muted-foreground text-pretty">
          One join across three tables. No exports, no three vendors to ask, nothing to reconcile by
          hand.
        </p>
      </div>
    </div>
  )
}

/*
  Two bars over the same 24 hours.

  The widths are illustrative of shape, not measured from a workload — a rented instance is billed
  for all of it, and a real small app runs in a handful of short bursts. The two figures beside them
  are the real dated comparison used elsewhere on the site.
*/
const BURSTS = [
  { run: 9, idle: 22 },
  { run: 5, idle: 31 },
  { run: 7, idle: 18 },
  { run: 4, idle: 0 },
] as const

export function IdleCostDiagram() {
  return (
    <div className="rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow text-muted-foreground">A rented instance</span>
        <span className="tnum font-mono text-sm text-husk">$51.94/mo</span>
      </div>
      <div
        aria-hidden="true"
        className="mt-2.5 h-8 rounded-md border rule-soft bg-muted-foreground/25"
      />
      <p className="mt-2 font-mono text-xs text-muted-foreground">billed every hour it exists</p>

      <div className="mt-7 flex items-baseline justify-between gap-3">
        <span className="eyebrow">On SproutOS</span>
        <span className="tnum font-mono text-sm text-husk">$0.02/mo</span>
      </div>
      <div
        aria-hidden="true"
        className="mt-2.5 flex h-8 overflow-hidden rounded-md border rule-soft bg-background/50"
      >
        {BURSTS.map((burst, i) => (
          <span key={i} className="contents">
            <span className="bg-primary" style={{ width: `${burst.run}%` }} />
            <span style={{ width: `${burst.idle}%` }} />
          </span>
        ))}
      </div>
      <p className="mt-2 font-mono text-xs text-muted-foreground">billed for the seconds it ran</p>

      <div className="mt-6 flex justify-between font-mono text-[0.6875rem] text-muted-foreground">
        <span>00:00</span>
        <span className="tracking-[0.08em]">SAME 24 HOURS</span>
        <span>24:00</span>
      </div>
    </div>
  )
}

/**
 * Upstream ships, your copy gets it, and the three things that can happen.
 *
 * The third outcome is the one worth drawing. "We keep your fork up to date" is what everybody
 * claims; what matters is the day upstream and your change touch the same lines, because that is
 * when a naive answer either loses your work or stops updating forever.
 */
export function UpkeepDiagram() {
  return (
    <div className="rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="rounded-xl border rule-soft bg-background/50 px-5 py-4">
        <p className="eyebrow mb-1.5">The original app</p>
        <p className="text-sm">Its maintainers keep shipping</p>
      </div>

      <div className="flex items-center gap-3 py-2.5 pl-5">
        <span aria-hidden="true" className="h-7 w-px bg-border" />
        <span className="font-mono text-xs text-muted-foreground">a fix, a new feature</span>
      </div>

      <div className="rounded-xl border border-primary/45 bg-primary/8 px-5 py-4">
        <p className="eyebrow mb-1.5">Your copy</p>
        <p className="text-sm">Gets it — your changes stay put</p>
      </div>

      <div className="flex items-center gap-3 py-2.5 pl-5">
        <span aria-hidden="true" className="h-7 w-px bg-border" />
        <span className="font-mono text-xs text-muted-foreground">
          daily, weekly, or on each release
        </span>
      </div>

      <div className="flex items-start gap-4 rounded-xl border border-dashed rule-soft px-5 py-4">
        <UpkeepLoop />
        <ul className="flex flex-col gap-2">
          <li className="text-[0.8125rem] text-pretty">
            <span className="font-medium">Nothing changed</span>{" "}
            <span className="text-muted-foreground">— the run costs seconds.</span>
          </li>
          <li className="text-[0.8125rem] text-pretty">
            <span className="font-medium">It merged</span>{" "}
            <span className="text-muted-foreground">— your app redeploys itself.</span>
          </li>
          <li className="text-[0.8125rem] text-pretty">
            <span className="font-medium">You both changed it</span>{" "}
            <span className="text-muted-foreground">
              — a pull request, never a silent overwrite.
            </span>
          </li>
        </ul>
      </div>
    </div>
  )
}
