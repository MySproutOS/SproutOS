import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { CheckIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "../lib/utils"

const DropdownMenu = MenuPrimitive.Root
const DropdownMenuTrigger = MenuPrimitive.Trigger
const DropdownMenuGroup = MenuPrimitive.Group
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

const itemClassName =
  "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] whitespace-nowrap outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-secondary data-highlighted:text-foreground [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

function DropdownMenuContent({
  className,
  children,
  sideOffset = 6,
  align = "start",
  ...props
}: MenuPrimitive.Positioner.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        data-slot="dropdown-menu-positioner"
        className="z-50 outline-none"
        sideOffset={sideOffset}
        align={align}
        {...props}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "min-w-44 origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/40 outline-none transition-[transform,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            className,
          )}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        itemClassName,
        variant === "destructive" &&
          "text-destructive data-highlighted:bg-destructive/12 data-highlighted:text-destructive [&_svg]:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      className={cn(itemClassName, "text-foreground hover:text-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(itemClassName, "relative pl-7", className)}
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="absolute left-2 text-primary">
        <CheckIcon className="size-3.5" />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(itemClassName, "relative pl-7", className)}
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="absolute left-2 text-primary">
        <CheckIcon className="size-3.5" />
      </MenuPrimitive.RadioItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

/**
 * Must be rendered inside `DropdownMenuGroup`. Base UI reads the group's context
 * to wire `aria-labelledby` and throws at render time if it is missing — the
 * failure is a blank screen, not a warning.
 */
function DropdownMenuGroupLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-group-label"
      className={cn("eyebrow px-2 py-1.5 text-[10px]", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("tnum ml-auto font-mono text-[11px] text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
}
