import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { cn } from "../lib/utils"

/*
  `indicatorClassName` exists so the credit-balance meter can paint its fill amber
  without amber leaking onto every other progress bar. Only a bar that reports
  money may pass it.
*/
function Progress({
  className,
  indicatorClassName,
  ...props
}: ProgressPrimitive.Root.Props & { indicatorClassName?: string }) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn("w-full", className)} {...props}>
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="h-[3px] w-full overflow-hidden rounded-full bg-soil-700"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn("h-full bg-primary transition-[width] duration-500", indicatorClassName)}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
