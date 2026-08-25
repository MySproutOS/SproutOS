import { Link, createFileRoute } from "@tanstack/react-router"
import { SearchIcon } from "lucide-react"
import { useState } from "react"
import { NewProjectDialog } from "@frontends/dashboard/components/projects/new-project-dialog"
import { Button } from "@ui/base/ui/button"
import { Input } from "@ui/base/ui/input"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { ProjectRow } from "@frontends/dashboard/components/project-row"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useProjects } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/projects/")({
  component: ProjectsList,
})

function ProjectsList() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useProjects(orgSlug)
  const [filter, setFilter] = useState("")

  const needle = filter.trim().toLowerCase()
  const projects =
    needle === ""
      ? data
      : data?.filter(
          (project) =>
            project.name.toLowerCase().includes(needle) ||
            project.repo.toLowerCase().includes(needle),
        )

  return (
    <>
      <PageHeader title="Projects" count={data?.length}>
        <div className="relative hidden w-55 sm:block">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
            }}
            placeholder="Search projects"
            aria-label="Search projects"
            className="pl-8"
          />
        </div>
        <NewProjectDialog orgSlug={orgSlug} />
      </PageHeader>

      <PageBody>
        {isPending && <ListSkeleton />}

        {isError && (
          <ListError
            title="Could not load projects"
            detail="The project list did not come back."
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {projects !== undefined && projects.length === 0 && needle === "" && (
          <EmptyState className="my-6">
            <EmptyStateIcon />
            <EmptyStateTitle>Nothing here yet</EmptyStateTitle>
            <EmptyStateDescription>Start from an app that already works.</EmptyStateDescription>
            <EmptyStateActions>
              <Button render={<Link to="/store" />}>Go to store</Button>
            </EmptyStateActions>
          </EmptyState>
        )}

        {projects !== undefined && projects.length === 0 && needle !== "" && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            No project matches “{filter}”.
          </p>
        )}

        {projects?.map((project) => (
          <ProjectRow key={project.id} orgSlug={orgSlug} project={project} />
        ))}
      </PageBody>
    </>
  )
}
