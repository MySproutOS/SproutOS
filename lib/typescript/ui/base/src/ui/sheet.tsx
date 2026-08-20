import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { XIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "../lib/utils"

/*
  A sheet is a Dialog anchored to an edge, not a second overlay stack. Building it
  on the same primitive keeps one portal and one focus trap, which is the whole
  reason ADR 0008 rules out mixing component libraries.
*/
const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close

const sheetVariants = cva(
  "fixed z-50 flex flex-col bg-card text-card-foreground shadow-2xl shadow-black/50 outline-none transition-transform duration-200 ease-out",
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-dvh w-72 max-w-[85vw] border-r border-border data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
        right:
          "inset-y-0 right-0 h-dvh w-72 max-w-[85vw] border-l border-border data-ending-style:translate-x-full data-starting-style:translate-x-full",
        top: "inset-x-0 top-0 max-h-[85vh] w-full border-b border-border data-ending-style:-translate-y-full data-starting-style:-translate-y-full",
        bottom:
          "inset-x-0 bottom-0 max-h-[85vh] w-full border-t border-border data-ending-style:translate-y-full data-starting-style:translate-y-full",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
)

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props &
  VariantProps<typeof sheetVariants> & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-backdrop"
        className="fixed inset-0 z-50 min-h-dvh bg-black/60 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(sheetVariants({ side, className }))}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            aria-label="Close"
            className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 border-b border-border px-4 py-3 pr-10", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm leading-none font-semibold", className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex items-center gap-2 border-t border-border px-4 py-3", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
}
