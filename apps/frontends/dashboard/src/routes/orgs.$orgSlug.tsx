import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@ui/base/ui/button"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { DashboardShell } from "@frontends/dashboard/components/shell/dashboard-shell"
import { useOrganization } from "@frontends/dashboard/data/organizations"

export const Route = createFileRoute("/orgs/$orgSlug")({
  component: OrgLayout,
})

/*
  A slug you cannot reach has to stop here. Falling through to the shell renders a
  fully working dashboard around an empty team switcher — a bookmarked URL for a
  team you were removed from would look like someone else's account loading, which
  is worse than an error. Only `isError` gates: while the lookup is in flight the
  shell renders as normal rather than flashing a spinner on every navigation.
*/
function OrgLayout() {
  const { orgSlug } = Route.useParams()
  const { isError } = useOrganization(orgSlug)

  if (isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <EmptyState className="max-w-md">
          <EmptyStateIcon />
          <EmptyStateTitle>No access to this organization</EmptyStateTitle>
          <EmptyStateDescription>
            <span className="tnum font-mono">{orgSlug}</span> does not exist, or you are no longer a
            member of it.
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button render={<Link to="/dashboard" />}>Back to your projects</Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    )
  }

  return <DashboardShell orgSlug={orgSlug} />
}
