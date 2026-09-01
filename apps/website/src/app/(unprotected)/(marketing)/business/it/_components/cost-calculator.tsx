"use client"

import { useId, useState } from "react"

/*
  The number an approver actually needs.

  IT does not need a pricing page; it needs to know which side of the approval threshold something
  falls on. So this asks the two questions that decide that — how many of these, and roughly how
  busy — and puts our figure next to what the same thing costs on a stack that cannot be turned off.

  ## What the numbers are, and are not

  Both sides are built from figures already published on this site, and neither is a quote.

  - The SproutOS side scales the worked example on the home page: one small app with its own
    database and its own automations, at roughly four cents a month. It is an illustration of the
    shape of the bill — usage-based, no floor — not a rate card. Real cost depends on real usage,
    and the per-dimension rates are in the billing documentation.
  - The comparison side uses the same dated list prices as the rest of the site: the cheapest
    always-on option each vendor sells. Supabase Pro is $25/mo with roughly $10/mo of compute for
    each project past the first; the AWS column is the smallest RDS, ElastiCache and OpenSearch
    instances, which is $51.94/mo per stack whether anybody uses it or not.

  Both are floors. The honest floor is already the whole argument, and a flattered comparison is
  worth nothing the first time a reader knows the real number.
*/

/** One small app: a site, its automations, and a database of its own. */
const SPROUT_PER_APP_MONTHLY = 0.04

/** Supabase Pro, plus its own compute for each project past the first. */
const SUPABASE_BASE = 25
const SUPABASE_PER_EXTRA_PROJECT = 10

/** The smallest RDS + ElastiCache + OpenSearch AWS sells, always on. */
const AWS_PER_STACK = 51.94

const USAGE = [
  { label: "Occasional", multiplier: 1, hint: "a daily job, a few visitors" },
  { label: "Steady", multiplier: 6, hint: "hourly jobs, hundreds of visitors" },
  { label: "Busy", multiplier: 25, hint: "per-minute jobs, thousands of visitors" },
] as const

function money(value: number) {
  if (value < 1) return `$${value.toFixed(2)}`
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

export function CostCalculator() {
  const [apps, setApps] = useState(12)
  const [usageIndex, setUsageIndex] = useState(1)
  const appsId = useId()

  const usage = USAGE[usageIndex] ?? USAGE[1]
  const sprout = apps * SPROUT_PER_APP_MONTHLY * usage.multiplier
  const supabase = SUPABASE_BASE + Math.max(0, apps - 1) * SUPABASE_PER_EXTRA_PROJECT
  const aws = apps * AWS_PER_STACK

  return (
    <div className="rounded-2xl border rule-soft bg-card/60 p-6 sm:p-8">
      <div className="grid gap-8 sm:grid-cols-2">
        <div>
          <label htmlFor={appsId} className="eyebrow mb-3 block">
            Small apps and automations
          </label>
          <input
            id={appsId}
            type="range"
            min={1}
            max={100}
            value={apps}
            onChange={(event) => {
              setApps(Number(event.target.value))
            }}
            className="w-full accent-primary"
          />
          <p className="mt-2 tnum font-mono text-sm text-foreground">
            {apps} {apps === 1 ? "app" : "apps"}
          </p>
        </div>

        <div>
          <p className="eyebrow mb-3">How busy they are</p>
          <div className="flex flex-wrap gap-2">
            {USAGE.map((option, index) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={index === usageIndex}
                onClick={() => {
                  setUsageIndex(index)
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                  index === usageIndex
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "rule-soft text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{usage.hint}</p>
        </div>
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border rule-soft bg-border/60 sm:grid-cols-3">
        <div className="bg-primary/8 p-5">
          <p className="eyebrow mb-2">On SproutOS</p>
          <p className="tnum font-mono text-3xl font-medium text-husk">{money(sprout)}</p>
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">per month, estimated</p>
        </div>
        <div className="bg-card/70 p-5">
          <p className="eyebrow mb-2">Supabase Pro</p>
          <p className="tnum font-mono text-3xl font-medium text-muted-foreground">
            {money(supabase)}
          </p>
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">
            plan, plus compute per project
          </p>
        </div>
        <div className="bg-card/70 p-5">
          <p className="eyebrow mb-2">Smallest AWS stack</p>
          <p className="tnum font-mono text-3xl font-medium text-muted-foreground">{money(aws)}</p>
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">always on, per app</p>
        </div>
      </div>

      <p className="mt-5 text-xs text-muted-foreground text-pretty">
        An estimate built from the example figures published elsewhere on this site, not a quote.
        The SproutOS column scales a worked example of one small app with its own database; the
        other two are the cheapest always-on option each vendor sells. Your real bill depends on
        your real usage, and nothing here has a monthly floor.
      </p>
    </div>
  )
}
