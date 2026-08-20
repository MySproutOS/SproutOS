import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1UserMePreferencesOptions,
  getV1UserMePreferencesQueryKey,
  patchV1UserMePreferencesMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
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

/**
 * The sidebar's collapsed state, kept in two places on purpose.
 *
 * **`localStorage` is what renders.** It is synchronous, so the rail is in its right shape on the
 * first frame; reading only from the server would mean every page load flashing an expanded
 * sidebar for one round trip, on every navigation, forever.
 *
 * **The server is what follows the person.** `user_preference.sidebar_collapsed` is why the same
 * choice applies on their other machine.
 *
 * They are reconciled once, on load, server-wins — the server value is the more recent deliberate
 * act if this browser is new, and identical if it is not. After that the local value leads and the
 * write is fire-and-forget: a failed PATCH must not un-collapse a sidebar somebody just collapsed.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const queryClient = useQueryClient()

  const preferences = useQuery(getV1UserMePreferencesOptions())
  const save = useMutation({
    ...patchV1UserMePreferencesMutation(),
    onSuccess: (data) => {
      // The response is the whole preferences shape, so it can be written straight into the cache
      // this reads from rather than merged into it.
      queryClient.setQueryData(getV1UserMePreferencesQueryKey(), data)
    },
  })

  /*
    Adopt the server value exactly once.

    Set during render rather than in an effect. This is React's documented shape for adjusting state
    when a prop or query result changes: React re-runs the component immediately, before committing
    or painting, so the sidebar never renders in the wrong shape. The effect version renders once
    wrong, commits, and renders again — a visible flicker, and what the `set-state-in-effect` lint
    rule is pointing at.

    Guarded on `adopted` rather than on the query settling, because a refetch — a window refocus,
    say — would otherwise reach back in and undo a toggle made in the meantime.

    `toggleCollapsed` also sets `adopted`, which closes the narrower race the guard alone does not:
    someone collapsing the sidebar inside the first few hundred milliseconds, before the query has
    resolved at all, would otherwise have it snap back when the response arrived. Once a person has
    said what they want in this session, a value written on an earlier visit does not get to
    overrule them. Found by the component test rather than by clicking — in a browser the query has
    always resolved long before a human reaches the control.
  */
  const [adopted, setAdopted] = useState(false)
  const serverCollapsed = preferences.data?.sidebarCollapsed
  if (!adopted && serverCollapsed !== undefined) {
    setAdopted(true)
    setCollapsed(serverCollapsed)
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed))
    } catch {
      // A blocked storage API is not a reason to lose the sidebar.
    }
  }, [collapsed])

  /*
    The next value is computed here rather than inside a `setCollapsed` updater,
    because the write has to sit outside it. Updater functions must be pure —
    React re-invokes them, and StrictMode does so deliberately — so a `mutate`
    call in there fires twice per toggle. Measured: one click, two PATCHes.
  */
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    setAdopted(true)
    // Fire and forget. This is furniture: a failed write costs the person nothing today and is
    // corrected the next time they touch it. Blocking the animation on a round trip would cost
    // them something every time.
    save.mutate({ body: { sidebarCollapsed: next } })
  }, [collapsed, save])

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
