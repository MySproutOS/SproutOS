import type * as React from "react"

import { cn } from "../lib/utils"

/*
  The one hand-drawn glyph in the system. Icons are lucide, but this is the brand
  mark — the paths are lifted verbatim from `design/parts/Components.html` so the
  empty state on screen matches the artboard stroke for stroke. lucide's `Sprout`
  is a near-miss and reads as a different plant next to the logo.
*/
function SproutMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
      {...props}
    >
      <path d="M12 21v-8.4" />
      <path d="M12 13.2C12 9.9 9.6 7.4 6 6.9c-.5 3.6 1.8 6.6 6 6.3Z" />
      <path d="M12 12.4c.2-3.6 2.6-6.2 6.2-6.7.4 3.8-2 6.8-6.2 6.7Z" />
    </svg>
  )
}

export { SproutMark }
