import type * as React from "react"

import { cn } from "../lib/utils"

/*
  A skeleton, not a spinner: on a list screen the shape of the answer is already
  known, so the placeholder should be that shape. `SkeletonText` draws the ragged
  line stack the component sheet specifies.
*/
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-sm bg-soil-700", className)}
      {...props}
    />
  )
}

const TEXT_LINE_WIDTHS = ["55%", "82%", "68%", "40%"] as const

function SkeletonText({
  lines = 4,
  className,
  ...props
}: React.ComponentProps<"div"> & { lines?: number }) {
  return (
    <div
      data-slot="skeleton-text"
      className={cn("flex w-full flex-col gap-2.5", className)}
      {...props}
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className="h-2.5"
          style={{ width: TEXT_LINE_WIDTHS[index % TEXT_LINE_WIDTHS.length] }}
        />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonText }
