// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SidebarProvider, useSidebar } from "./sidebar-context"

/**
 * The sidebar's write behaviour, under StrictMode, as the app actually mounts it.
 *
 * This file exists because of a bug that shipped and could not have been caught by anything else
 * here. `save.mutate(...)` sat inside a `setCollapsed` updater; updater functions must be pure and
 * React re-invokes them — StrictMode deliberately — so one click wrote twice. Lint does not flag an
 * impure updater, types cannot see it, and the dashboard had no component tests at all, so the only
 * way it was ever going to be found was somebody watching a network panel.
 *
 * `<StrictMode>` here is not decoration: without it the double-invocation never happens and this
 * test passes against the bug. `main.tsx` wraps the real app in it, so this matches production
 * development behaviour.
 *
 * `fetch` is stubbed rather than the mutation hook mocked. Mocking our own hook would test the mock;
 * counting requests tests the thing that was actually wrong.
 */

function Toggle() {
  const { collapsed, toggleCollapsed } = useSidebar()
  return (
    <button type="button" onClick={toggleCollapsed}>
      {collapsed ? "collapsed" : "expanded"}
    </button>
  )
}

function renderSidebar() {
  // `retry: false` so a stubbed failure surfaces immediately instead of being retried into a
  // timeout, and a fresh client per test so no cache leaks between them.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <Toggle />
        </SidebarProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

let patches: string[] = []
let calls: string[] = []

beforeEach(() => {
  patches = []
  calls = []
  window.localStorage.clear()

  vi.stubGlobal(
    "fetch",
    /*
      The method comes off the `Request`, not off `init`.

      The generated client builds a `Request` and calls `fetch(request)` with one argument, so
      `init` is always undefined. Reading `init?.method ?? "GET"` reports every call as a GET —
      which looks right for the GETs and silently loses every write. It cost me a debugging round:
      the toggle was firing and the test still said zero writes.
    */
    vi.fn((input: unknown, init?: { method?: string }) => {
      const request = input as { url?: string; method?: string }
      const url = typeof input === "string" ? input : String(request?.url ?? "")
      const method = (request?.method ?? init?.method ?? "GET").toUpperCase()

      calls.push(`${method} ${url}`)
      if (method === "PATCH") patches.push(url)

      // The shape `GET /me/preferences` returns, which is also what the PATCH returns — one shape,
      // so the provider can write the response straight into the cache it reads from.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            lastOrganizationId: null,
            lastOrganizationSlug: null,
            sidebarCollapsed: false,
            navPinnedProjectIds: [],
            timezone: "UTC",
            productEmails: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
})

afterEach(() => {
  // Explicit: testing-library only auto-cleans when vitest globals are on, and they are not here.
  // Without it the second test finds two buttons — the first test's tree is still mounted.
  cleanup()
  vi.unstubAllGlobals()
})

describe("the sidebar's persistence", () => {
  it("writes once per toggle, not once per render", async () => {
    renderSidebar()

    // `fireEvent`, not `element.click()`. React 19 delegates from the root and testing-library
    // wraps the dispatch in `act`, so a raw DOM click can be observed before React has flushed the
    // state update it caused.
    fireEvent.click(await screen.findByRole("button"))

    // Settle the mutation. The assertion is a count, so this has to be long enough that a *second*
    // write would have been made by now — otherwise it passes against the bug by racing it.
    await vi.waitFor(() => {
      expect(patches.length, `fetch calls seen: ${JSON.stringify(calls)}`).toBeGreaterThan(0)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatch(/\/v1\/user\/me\/preferences$/)
  })

  it("keeps the local value in step with what it wrote", async () => {
    renderSidebar()

    const button = await screen.findByRole("button")
    expect(button.textContent).toBe("expanded")

    fireEvent.click(button)

    await vi.waitFor(() => {
      expect(screen.getByRole("button").textContent).toBe("collapsed")
    })
    // `localStorage` is what renders on the next load, so it has to agree with the write.
    expect(window.localStorage.getItem("sproutos.sidebar.collapsed")).toBe("true")
  })
})
