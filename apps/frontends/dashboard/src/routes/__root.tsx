import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { getV1AuthMeOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { Button } from "@ui/base/ui/button"
import { Spinner } from "@ui/base/ui/spinner"
import { TooltipProvider } from "@ui/base/ui/tooltip"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState className="max-w-md">
        <EmptyStateIcon />
        <EmptyStateTitle>No such page</EmptyStateTitle>
        <EmptyStateDescription>
          That URL does not match anything in the dashboard.
        </EmptyStateDescription>
        <EmptyStateActions>
          <Button render={<Link to="/dashboard" />}>Back to your projects</Button>
        </EmptyStateActions>
      </EmptyState>
    </div>
  )
}

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
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  }

  if (unauthenticated) {
    return null
  }

  return (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  )
}
