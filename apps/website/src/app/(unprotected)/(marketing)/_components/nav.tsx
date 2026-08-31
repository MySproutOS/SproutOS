"use client"

import { SproutMark } from "@website/components/icons"
import { Button } from "@ui/base/ui/button"
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuPopup,
  NavigationMenuTrigger,
} from "@ui/base/ui/navigation-menu"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@ui/base/ui/sheet"
import { MenuIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { NAV } from "./nav-items"

/**
 * The marketing header.
 *
 * Every top-level item is a menu. None of them is a link — including Docs, which has a users and a
 * developers side and no useful single destination. The tree comes from `NAV` so the mobile sheet
 * and the footer cannot drift from it.
 */
export function Nav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
    }
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b rule-soft bg-background/85 backdrop-blur-md"
          : "border-b border-transparent"
      }`}
    >
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <SproutMark className="size-6 text-primary" />
          <span className="font-display text-[1.0625rem] font-semibold tracking-tight">
            SproutOS
          </span>
        </Link>

        <NavigationMenu className="hidden lg:block">
          <NavigationMenuList className="relative flex items-center gap-1">
            {NAV.map((group) => (
              <NavigationMenuItem key={group.label}>
                <NavigationMenuTrigger>{group.label}</NavigationMenuTrigger>
                <NavigationMenuContent>
                  <ul className="grid w-[22rem] gap-1">
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <NavigationMenuLink render={<Link href={item.href} />}>
                          <span className="block text-sm font-medium text-foreground">
                            {item.label}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground text-pretty">
                            {item.description}
                          </span>
                        </NavigationMenuLink>
                      </li>
                    ))}
                  </ul>
                </NavigationMenuContent>
              </NavigationMenuItem>
            ))}
          </NavigationMenuList>
          <NavigationMenuPopup />
        </NavigationMenu>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="hidden sm:inline-flex"
            render={<Link href="/login">Log In</Link>}
          />
          <Button size="sm" render={<Link href="/login">Sign up</Link>} />
          <MobileNav />
        </div>
      </div>
    </header>
  )
}

/**
 * Below `lg` the dropdown row is hidden, so without this there is no navigation at all on a phone —
 * which is how `/docs`, `/download` and `/legal` were unreachable on mobile even after they existed.
 */
function MobileNav() {
  const [open, setOpen] = useState(false)

  // A link inside the sheet navigates without unmounting it, so every link closes it on the way out.
  const close = () => {
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open navigation"
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:hidden"
      >
        <MenuIcon className="size-5" />
      </SheetTrigger>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
        </SheetHeader>
        <SheetBody className="px-4 py-4">
          <nav className="flex flex-col gap-6">
            {NAV.map((group) => (
              <div key={group.label}>
                <p className="eyebrow mb-2">{group.label}</p>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={close}
                        className="-mx-2 block rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <Link
              href="/login"
              onClick={close}
              className="-mx-2 block rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-secondary sm:hidden"
            >
              Log In
            </Link>
          </nav>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
