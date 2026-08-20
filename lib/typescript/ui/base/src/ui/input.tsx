import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "../lib/utils"

const inputClassName =
  "flex h-8 w-full min-w-0 rounded-lg border border-border bg-soil-800 px-2.5 text-[13px] text-foreground transition-[color,box-shadow,border-color] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:bg-background disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-invalid:border-destructive file:h-full file:border-0 file:bg-transparent file:text-[13px] file:font-medium"

function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn(inputClassName, className)} {...props} />
}

export { Input, inputClassName }
