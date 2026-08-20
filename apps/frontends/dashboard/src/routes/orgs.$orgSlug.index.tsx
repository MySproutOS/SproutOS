import { Navigate, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/orgs/$orgSlug/")({
  component: OrgIndex,
})

function OrgIndex() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/orgs/$orgSlug/projects" params={{ orgSlug }} replace />
}
