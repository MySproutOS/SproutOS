import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { getV1AuthMeOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const { data, isLoading, isError } = useQuery(getV1AuthMeOptions())
  // Gate on `isLoading`: until the query settles there is nothing to conclude, and treating the
  // in-flight state as unauthenticated would redirect every visitor to /login before their
  // session is ever checked.
  const unauthenticated = !isLoading && (isError || (data?.user ?? null) === null)

  // Navigating is a side effect, so it belongs in an effect rather than in render.
  useEffect(() => {
    if (unauthenticated) {
      window.location.href = `${import.meta.env.VITE_NEXTJS_URL ?? ""}/login?next=${window.location.pathname}`
    }
  }, [unauthenticated])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (unauthenticated) {
    return null
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-sidebar p-4">
        <h2 className="mb-6 text-lg font-semibold text-sidebar-foreground">Dashboard</h2>
        <nav className="flex flex-col gap-2">
          <Link
            to="/dashboard"
            className="rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent [&.active]:bg-sidebar-accent [&.active]:font-medium"
          >
            Home
          </Link>
          <Link
            to="/profile"
            className="rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent [&.active]:bg-sidebar-accent [&.active]:font-medium"
          >
            Profile
          </Link>
          <Link
            to="/settings"
            className="rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent [&.active]:bg-sidebar-accent [&.active]:font-medium"
          >
            Settings
          </Link>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  )
}
