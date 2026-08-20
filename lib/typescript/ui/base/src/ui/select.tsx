import { Select as SelectPrimitive } from "@base-ui/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "../lib/utils"

const Select = SelectPrimitive.Root

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-border bg-soil-800 px-2.5 text-[13px] whitespace-nowrap text-foreground transition-[color,box-shadow,border-color] outline-none select-none hover:not-data-disabled:bg-soil-700/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 data-disabled:pointer-events-none data-disabled:opacity-60 data-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon" className="text-muted-foreground">
        <ChevronDownIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(
        "truncate text-left data-placeholder:text-muted-foreground [&>span]:truncate",
        className,
      )}
      {...props}
    />
  )
}

function SelectContent({
  className,
  children,
  sideOffset = 4,
  align = "start",
  ...props
}: SelectPrimitive.Positioner.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        className="z-50 outline-none select-none"
        sideOffset={sideOffset}
        align={align}
        {...props}
      >
        <SelectPrimitive.Popup
          data-slot="select-popup"
          className={cn(
            "min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/40 outline-none transition-[transform,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            className,
          )}
        >
          <SelectPrimitive.List
            data-slot="select-list"
            className="max-h-[var(--available-height)] overflow-y-auto"
          >
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "grid h-7 cursor-default grid-cols-[0.875rem_1fr] items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-secondary data-highlighted:text-foreground",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator
        data-slot="select-item-indicator"
        className="col-start-1 text-primary"
      >
        <CheckIcon className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText data-slot="select-item-text" className="col-start-2 truncate">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

/** Must be rendered inside `SelectGroup`, for the same reason as the menu's. */
function SelectGroupLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn("eyebrow px-2 py-1.5 text-[10px]", className)}
      {...props}
    />
  )
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-xs font-medium select-none", className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
  SelectSeparator,
  SelectLabel,
}
