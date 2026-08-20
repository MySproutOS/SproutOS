import { Link, createFileRoute } from "@tanstack/react-router"
import { ScrollTextIcon } from "lucide-react"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/base/ui/card"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useProjects } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/observability")({
  component: Observability,
})

/**
 * An index, not a viewer.
 *
 * Logs belong to a *project* — that is what an ingest key is scoped to, and what
 * `observability:logs:read` is checked against. An organization-wide log stream would be a single
 * search across every project a caller might have different permissions on, and the RBAC answer to
 * "show me everything I am allowed to see" is a different feature from "show me this project".
 *
 * So this lists the projects and sends you to one.
 */
function Observability() {
  const { orgSlug } = Route.useParams()
  const projects = useProjects(orgSlug)

  return (
    <>
      <PageHeader title="Observability" count={projects.data?.length} />
      <PageBody>
        {projects.isPending ? <ListSkeleton rows={4} /> : null}
        {projects.isError ? <ListError onRetry={() => void projects.refetch()} /> : null}

        {!projects.isPending && !projects.isError && (projects.data ?? []).length === 0 ? (
          <EmptyState className="my-6">
            <EmptyStateIcon>
              <ScrollTextIcon className="size-[26px] text-primary" />
            </EmptyStateIcon>
            <EmptyStateTitle>No projects yet</EmptyStateTitle>
            <EmptyStateDescription>
              Logs are collected per project. Create one, then point an OpenTelemetry exporter at
              it.
            </EmptyStateDescription>
          </EmptyState>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(projects.data ?? []).map((project) => (
            <Card key={project.id}>
              <CardHeader>
                <CardTitle className="truncate">{project.name}</CardTitle>
                {/*
                  `CardDescription`, not a bare <p>. CardHeader is a `grid-cols-[1fr_auto]` and
                  only the card components carry `col-start-1` — an element without it lands in
                  column two and, being wide, squeezes the title's `1fr` to nothing.
                */}
                <CardDescription className="truncate font-mono">{project.repo}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  size="sm"
                  render={
                    <Link
                      to="/orgs/$orgSlug/projects/$projectId/logs"
                      params={{ orgSlug, projectId: project.id }}
                    />
                  }
                >
                  <ScrollTextIcon className="size-4" />
                  View logs
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  )
}
