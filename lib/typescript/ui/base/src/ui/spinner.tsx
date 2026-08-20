import { LoaderCircleIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "../lib/utils"

/*
  Reserved for indeterminate work with no known shape — a pending mutation, a
  button mid-submit. List screens use `Skeleton` instead.

  The `<output>` wrapper is the live region: `role="status"` on the svg is the
  same semantics spelled the way screen readers handle worse.
*/
function Spinner({
  className,
  label = "Loading",
  ...props
}: React.ComponentProps<typeof LoaderCircleIcon> & { label?: string }) {
  return (
    <output aria-label={label} className="inline-flex">
      <LoaderCircleIcon
        aria-hidden="true"
        data-slot="spinner"
        className={cn("size-4 shrink-0 animate-spin", className)}
        {...props}
      />
    </output>
  )
}

export { Spinner }
