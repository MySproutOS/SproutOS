import type * as React from "react"

import { cn } from "../lib/utils"

/*
  The single place amber is allowed. Route every cost, balance, price, and usage
  total through this component and the rule from ADR 0010 becomes greppable:
  `text-husk` outside this file is a review failure.
*/
function Money({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"span"> & { size?: "sm" | "default" | "lg" }) {
  return (
    <span
      data-slot="money"
      className={cn(
        "tnum font-mono text-husk",
        size === "sm" && "text-[11px]",
        size === "default" && "text-[13px]",
        size === "lg" && "text-[15px] font-medium",
        className,
      )}
      {...props}
    />
  )
}

export { Money }
