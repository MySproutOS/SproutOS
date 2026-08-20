import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "../lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border border-transparent bg-soil-600 p-0.5 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50 data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[15px] rounded-full bg-bone shadow-sm transition-[translate,background-color] data-checked:translate-x-[15px] data-checked:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
