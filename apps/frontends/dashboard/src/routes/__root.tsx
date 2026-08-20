import { useQuery } from "@tanstack/react-query"
import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { getV1AuthMeOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { Button } from "@ui/base/ui/button"
import { ImpersonationBanner } from "@frontends/dashboard/components/shell/impersonation-banner"
import { Spinner } from "@ui/base/ui/spinner"
import { TooltipProvider } from "@ui/base/ui/tooltip"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { ListError } from "@frontends/dashboard/components/list-states"

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
})

/*
  Without this, a render error anywhere in the tree takes the whole SPA to a blank
  page and TanStack only warns about it in the console. A route's own error state
  covers a failed request; this covers the bug that request data provokes.
*/
function RootError({ error }: { error: Error }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <ListError
          title="Something broke on this screen"
          detail={<code>{error.message}</code>}
          onRetry={() => {
            window.location.reload()
          }}
        />
      </div>
    </div>
  )
}

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
      {/*
        Here rather than inside `DashboardShell`, which was the first place it went.

        The shell only renders once an organization has resolved, so on every screen before that —
        the loading state, and the "could not find your organization" error an admin lands on when
        they impersonate someone with no team — the banner was absent and there was no way to end
        the session. An admin stranded on an error page with a stranger's cookie and no exit is the
        exact situation the banner exists to prevent.
      */}
      <ImpersonationBanner />
      <Outlet />
    </TooltipProvider>
  )
}
