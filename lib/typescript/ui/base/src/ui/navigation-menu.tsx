import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "../lib/utils"

/*
  Site navigation, which is not the same component as a menu.

  `DropdownMenu` models a menu of *commands* on a control: one popup per trigger, opened by click,
  with `menuitem` roles. A marketing header is a set of *links* grouped under headings, opened by
  hover, where moving between triggers should slide one popup rather than close and open two. Base
  UI ships that as a separate primitive with the right roles and the shared morphing viewport, so
  this wraps that rather than bending the menu into the shape.

  ADR 0008: Base UI only. ADR 0010: the theme is dark-only, so there are no `dark:` utilities here —
  the tokens already carry the one palette.
*/

const NavigationMenu = NavigationMenuPrimitive.Root
const NavigationMenuList = NavigationMenuPrimitive.List
const NavigationMenuItem = NavigationMenuPrimitive.Item

const navigationMenuTriggerClassName =
  "flex h-9 cursor-default items-center gap-1 rounded-md px-3 text-sm text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-popup-open:text-foreground"

function NavigationMenuTrigger({
  className,
  children,
  ...props
}: NavigationMenuPrimitive.Trigger.Props) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(navigationMenuTriggerClassName, className)}
      {...props}
    >
      {children}
      <NavigationMenuPrimitive.Icon className="transition-transform duration-200 data-popup-open:rotate-180">
        <ChevronDownIcon className="size-3.5" />
      </NavigationMenuPrimitive.Icon>
    </NavigationMenuPrimitive.Trigger>
  )
}

function NavigationMenuContent({ className, ...props }: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        "h-full w-[calc(100vw-2.5rem)] p-2 sm:w-max",
        "transition-[opacity,translate] duration-[var(--duration)] ease-[var(--easing)]",
        "data-starting-style:opacity-0 data-ending-style:opacity-0",
        "data-starting-style:data-[activation-direction=left]:-translate-x-1/2",
        "data-starting-style:data-[activation-direction=right]:translate-x-1/2",
        "data-ending-style:data-[activation-direction=left]:translate-x-1/2",
        "data-ending-style:data-[activation-direction=right]:-translate-x-1/2",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The popup, its positioner and its viewport in one part, because they are never useful apart and
 * three nested wrappers at every call site is how the arrow ends up misaligned in one of them.
 *
 * The `before:` pseudo-element on the positioner bridges the gap between trigger and popup, so
 * moving the pointer down into the menu does not cross a dead strip that closes it.
 */
function NavigationMenuPopup({
  className,
  sideOffset = 10,
  ...props
}: NavigationMenuPrimitive.Positioner.Props) {
  return (
    <NavigationMenuPrimitive.Portal>
      <NavigationMenuPrimitive.Positioner
        data-slot="navigation-menu-positioner"
        sideOffset={sideOffset}
        collisionPadding={{ top: 5, bottom: 5, left: 20, right: 20 }}
        collisionAvoidance={{ side: "none" }}
        className={cn(
          "z-50 h-[var(--positioner-height)] w-[var(--positioner-width)] max-w-[var(--available-width)]",
          "transition-[top,left,right,bottom] duration-[var(--duration)] ease-[var(--easing)] data-instant:transition-none",
          "before:absolute before:content-['']",
          "data-[side=bottom]:before:top-[-10px] data-[side=bottom]:before:right-0 data-[side=bottom]:before:left-0 data-[side=bottom]:before:h-2.5",
          className,
        )}
        style={{
          ["--duration" as string]: "0.35s",
          ["--easing" as string]: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
        {...props}
      >
        <NavigationMenuPrimitive.Popup
          data-slot="navigation-menu-popup"
          className={cn(
            "relative h-[var(--popup-height)] w-[var(--popup-width)] origin-[var(--transform-origin)]",
            "rounded-xl border border-border bg-popover text-popover-foreground shadow-lg shadow-black/40 outline-none",
            "transition-[opacity,transform,width,height] duration-[var(--duration)] ease-[var(--easing)]",
            "data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            "data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-150",
          )}
        >
          <NavigationMenuPrimitive.Viewport className="relative h-full w-full overflow-hidden" />
        </NavigationMenuPrimitive.Popup>
      </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
  )
}

/**
 * One link row: a title with a line of explanation under it.
 *
 * `render` takes the framework link — `render={<Link href={href} />}` — so client-side routing and
 * prefetching survive the wrapper.
 */
function NavigationMenuLink({ className, ...props }: NavigationMenuPrimitive.Link.Props) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={cn(
        "block rounded-lg p-3 text-left no-underline transition-colors outline-none",
        "hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuPopup,
  NavigationMenuLink,
  navigationMenuTriggerClassName,
}
