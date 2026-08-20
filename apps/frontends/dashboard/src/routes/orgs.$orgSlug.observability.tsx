import { createFileRoute } from "@tanstack/react-router"
import { GlobeIcon } from "lucide-react"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"

/*
  A stub, and deliberately one. `design/parts/Main.html` puts Observability in the
  sidebar, so the route has to exist for the nav item to be a real typed link —
  but metrics and logs are their own task and are not built here.
*/
export const Route = createFileRoute("/orgs/$orgSlug/observability")({
  component: Observability,
})

function Observability() {
  return (
    <>
      <PageHeader title="Observability" />
      <PageBody>
        <EmptyState className="my-6">
          <EmptyStateIcon>
            <GlobeIcon className="size-[26px] text-primary" />
          </EmptyStateIcon>
          <EmptyStateTitle>Not wired up yet</EmptyStateTitle>
          <EmptyStateDescription>
            Metrics, logs, and traces land here once the metering pipeline is exposed to the
            dashboard.
          </EmptyStateDescription>
        </EmptyState>
      </PageBody>
    </>
  )
}
