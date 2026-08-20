import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "../lib/utils"

function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-ring/20",
          viewportClassName,
        )}
      >
        <ScrollAreaPrimitive.Content data-slot="scroll-area-content">
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaScrollbar />
      <ScrollAreaScrollbar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollAreaScrollbar({ className, ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      className={cn(
        "m-0.5 flex touch-none rounded-full opacity-0 transition-opacity select-none data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="flex-1 rounded-full bg-soil-600"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea }
