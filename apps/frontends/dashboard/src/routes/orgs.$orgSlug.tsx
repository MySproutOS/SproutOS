import { createFileRoute } from "@tanstack/react-router"
import { DashboardShell } from "@frontends/dashboard/components/shell/dashboard-shell"

export const Route = createFileRoute("/orgs/$orgSlug")({
  component: OrgLayout,
})

function OrgLayout() {
  const { orgSlug } = Route.useParams()
  return <DashboardShell orgSlug={orgSlug} />
}
