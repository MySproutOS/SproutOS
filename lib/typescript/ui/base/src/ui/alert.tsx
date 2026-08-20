import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

import { cn } from "../lib/utils"

/*
  There is no money variant and never will be: amber marks a figure that costs the
  reader something, and a banner is not a figure. A degraded-service notice uses
  `warning`, which is its own token.
*/
const alertVariants = cva(
  "relative grid w-full grid-cols-[auto_1fr] items-start gap-x-2 gap-y-1.5 rounded-lg border p-4 text-sm [&>svg]:size-4 [&>svg]:translate-y-px [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-foreground [&>svg]:text-muted-foreground",
        destructive: "border-destructive/30 bg-destructive/6 [&>svg]:text-destructive",
        warning: "border-warning/30 bg-warning/6 [&>svg]:text-warning",
        success: "border-leaf/30 bg-leaf/6 [&>svg]:text-leaf",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role="alert"
      data-slot="alert"
      data-variant={variant}
      className={cn(alertVariants({ variant, className }))}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 text-[13px] leading-none font-medium in-data-[variant=destructive]:text-destructive in-data-[variant=warning]:text-warning",
        className,
      )}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground [&_code]:font-mono [&_code]:text-[11.5px]",
        className,
      )}
      {...props}
    />
  )
}

function AlertActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-actions"
      className={cn("col-start-2 mt-0.5 flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertActions, alertVariants }
