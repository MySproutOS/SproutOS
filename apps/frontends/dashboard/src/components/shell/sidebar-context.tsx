import { createContext, use, useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

const COLLAPSED_STORAGE_KEY = "sproutos.sidebar.collapsed"

type SidebarState = {
  collapsed: boolean
  toggleCollapsed: () => void
  mobileOpen: boolean
  setMobileOpen: (open: boolean) => void
}

const SidebarContext = createContext<SidebarState | null>(null)

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed))
    } catch {
      // A blocked storage API is not a reason to lose the sidebar.
    }
  }, [collapsed])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current)
  }, [])

  /*
    `collapsed` is a desktop preference. The mobile drawer renders the same body,
    and an icon-only drawer would be absurd — so while the drawer is open the
    shared value reports expanded. The desktop rail is `hidden md:flex`, and the
    shell closes the drawer on the way up past `md`, so the two never disagree
    on screen.
  */
  const value = useMemo(
    () => ({ collapsed: collapsed && !mobileOpen, toggleCollapsed, mobileOpen, setMobileOpen }),
    [collapsed, toggleCollapsed, mobileOpen],
  )

  return <SidebarContext value={value}>{children}</SidebarContext>
}

export function useSidebar() {
  const context = use(SidebarContext)
  if (context === null) {
    throw new Error("useSidebar must be used inside a SidebarProvider")
  }
  return context
}
