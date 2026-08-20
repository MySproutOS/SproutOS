import { Navigate, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/orgs/$orgSlug/settings/")({
  component: SettingsIndex,
})

function SettingsIndex() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/orgs/$orgSlug/settings/profile" params={{ orgSlug }} replace />
}
