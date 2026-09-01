"use client"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/base/ui/tooltip"

/**
 * A detail worth being exact about, kept out of the sentence that makes the point.
 *
 * The claim on the page has to be short enough to land; the qualification that makes it *true* is
 * usually longer than the claim. Putting the qualification behind an icon lets both exist without
 * the body copy turning into a footnote — and a reader who suspects the number is being flattered
 * can check it in place rather than taking it on faith.
 *
 * A `button` rather than a bare `span`: Base UI's tooltip opens on focus as well as hover, so this
 * is reachable by keyboard and announced by a screen reader. A hover-only tooltip hides the
 * qualification from exactly the readers who cannot hover.
 */
export function InfoTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className="inline-flex size-4 shrink-0 translate-y-px items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          }
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="size-4"
          >
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 7.25v3.5" strokeLinecap="round" />
            <path d="M8 5.25v.25" strokeLinecap="round" />
          </svg>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-pretty">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
