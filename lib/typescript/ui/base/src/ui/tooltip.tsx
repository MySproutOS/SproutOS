import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "../lib/utils"

const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

/*
  `delay` lives on the provider in Base UI, not on the root — the grouping logic
  is what makes a toolbar of icon buttons feel like one control rather than eight.
*/
function TooltipProvider({ delay = 250, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />
}

function TooltipContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: TooltipPrimitive.Positioner.Props) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        data-slot="tooltip-positioner"
        className="z-50"
        sideOffset={sideOffset}
        {...props}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "origin-[var(--transform-origin)] rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg shadow-black/40 transition-[transform,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            className,
          )}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent }
