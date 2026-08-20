"use client"

import { useEffect, useRef, useState } from "react"

const LINE_ITEMS = [
  { label: "Your app, hosted", detail: "1,000 visitors", cents: 1 },
  { label: "Automations", detail: "awake only when used", cents: 1 },
  { label: "Your database", detail: "1,000 accounts", cents: 2 },
] as const

const SPROUT_MONTHLY = 0.04
const TYPICAL_MONTHLY = 25
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60

function usd(perMonth: number, seconds: number, digits: number) {
  return ((perMonth / SECONDS_PER_MONTH) * seconds).toFixed(digits)
}

/**
 * The receipt is the page's thesis: the whole product argument is the total at
 * the bottom. The live meter underneath is the proof — it runs the same clock
 * against both bills and lets the reader watch one of them not move.
 */
export function CostReceipt() {
  // Reduced motion gets a single settled reading rather than a running meter.
  const [seconds, setSeconds] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 60
      : 0,
  )
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    startedAt.current = performance.now()
    let frame = 0
    const tick = () => {
      if (startedAt.current !== null) {
        setSeconds((performance.now() - startedAt.current) / 1000)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [])

  const total = LINE_ITEMS.reduce((sum, item) => sum + item.cents, 0)

  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute -inset-6 -z-10 rounded-[2rem] bg-primary/8 blur-3xl"
      />
      <figure className="overflow-hidden rounded-2xl border rule-soft bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-sm">
        <figcaption className="flex items-center justify-between gap-3 border-b rule-soft px-5 py-3.5 sm:px-6">
          <span className="eyebrow">Estimated monthly bill</span>
          <span className="font-mono text-[0.6875rem] text-muted-foreground">EXAMPLE APP</span>
        </figcaption>

        <div className="px-5 py-5 sm:px-6">
          <ul className="flex flex-col gap-3.5">
            {LINE_ITEMS.map((item) => (
              <li key={item.label} className="flex items-baseline gap-3">
                <span className="text-sm text-foreground">{item.label}</span>
                <span
                  aria-hidden="true"
                  className="mx-1 h-px min-w-4 flex-1 self-center border-b border-dotted border-border"
                />
                <span className="font-mono text-xs text-muted-foreground">{item.detail}</span>
                <span className="tnum w-14 text-right font-mono text-sm text-husk">
                  ${(item.cents / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex items-baseline justify-between border-t rule-soft pt-5">
            <span className="eyebrow">Total / month</span>
            <span className="tnum font-mono text-3xl font-medium text-husk sm:text-4xl">
              ${(total / 100).toFixed(2)}
            </span>
          </div>
        </div>

        <div className="border-t rule-soft bg-background/45 px-5 py-4 sm:px-6">
          <p className="eyebrow mb-3 flex items-center gap-2">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
            Billed while you've been reading
          </p>
          <dl className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-foreground">On SproutOS</dt>
              <dd className="tnum font-mono text-sm text-primary">
                ${usd(SPROUT_MONTHLY, seconds, 8)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                On a typical managed stack{" "}
                <span className="font-mono text-xs">(~${TYPICAL_MONTHLY}/mo)</span>
              </dt>
              <dd className="tnum font-mono text-sm text-muted-foreground">
                ${usd(TYPICAL_MONTHLY, seconds, 8)}
              </dd>
            </div>
          </dl>
        </div>
      </figure>
    </div>
  )
}
