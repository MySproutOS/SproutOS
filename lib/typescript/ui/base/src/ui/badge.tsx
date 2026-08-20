import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

import { cn } from "../lib/utils"

/*
  Status pills from the component sheet. There is deliberately no money variant:
  amber is the money channel and money is rendered as a figure, never as a chip.
*/
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-[11px] leading-4 font-normal whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-secondary text-foreground",
        muted: "bg-secondary text-muted-foreground",
        success: "border-leaf/30 bg-leaf/12 text-leaf",
        warning: "border-warning/30 bg-warning/12 text-warning",
        destructive: "border-destructive/30 bg-destructive/12 text-destructive",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { Badge, badgeVariants }
