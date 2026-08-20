import { Outlet } from "@tanstack/react-router"
import { useEffect } from "react"
import { Sheet, SheetContent, SheetTitle } from "@ui/base/ui/sheet"
import { SidebarBody, Sidebar } from "@frontends/dashboard/components/shell/sidebar"
import { SidebarProvider, useSidebar } from "@frontends/dashboard/components/shell/sidebar-context"

function MobileSidebar({ orgSlug }: { orgSlug: string }) {
  const { mobileOpen, setMobileOpen } = useSidebar()

  useEffect(() => {
    const query = window.matchMedia("(min-width: 48rem)")
    const close = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false)
    }
    query.addEventListener("change", close)
    return () => {
      query.removeEventListener("change", close)
    }
  }, [setMobileOpen])

  return (
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <SheetContent side="left" className="w-58 bg-sidebar p-0 md:hidden">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarBody orgSlug={orgSlug} />
      </SheetContent>
    </Sheet>
  )
}

/**
 * The chrome every authenticated screen sits inside. `/store` renders it too, with
 * the reader's current organization, so the nav does not vanish on a shared route.
 */
export function DashboardShell({ orgSlug }: { orgSlug: string }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-dvh">
        <Sidebar orgSlug={orgSlug} />
        <MobileSidebar orgSlug={orgSlug} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarProvider>
  )
}
