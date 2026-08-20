import type * as React from "react"

import { cn } from "../lib/utils"
import { SproutMark } from "./sprout-mark"

/*
  The dashed border is what separates "you have nothing" from "something failed to
  load" at a glance — a solid card reads as content. The error state uses `Alert`
  and the loading state uses `Skeleton`; every list screen owes all three.
*/
function EmptyState({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border px-5 py-10 text-center",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function EmptyStateIcon({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="empty-state-icon" className={cn("text-primary", className)} {...props}>
      {children ?? <SproutMark className="size-[26px]" />}
    </div>
  )
}

function EmptyStateTitle({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-state-title"
      className={cn("text-[13px] leading-none font-medium", className)}
      {...props}
    />
  )
}

function EmptyStateDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-state-description"
      className={cn("max-w-[42ch] text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

function EmptyStateActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-actions"
      className={cn("mt-0.5 flex flex-wrap items-center justify-center gap-2", className)}
      {...props}
    />
  )
}

export { EmptyState, EmptyStateIcon, EmptyStateTitle, EmptyStateDescription, EmptyStateActions }
