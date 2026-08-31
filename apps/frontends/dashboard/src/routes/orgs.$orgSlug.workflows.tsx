import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Badge } from "@ui/base/ui/badge"
import { Money } from "@ui/base/ui/money"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
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
import { NewProjectDialog } from "@frontends/dashboard/components/projects/new-project-dialog"
import { isStandaloneWorkflowProject, useProjects } from "@frontends/dashboard/data/projects"
import {
  WORKFLOW_STATUS_LABELS,
  useWorkflows,
  type WorkflowStatus,
} from "@frontends/dashboard/data/workflows"

export const Route = createFileRoute("/orgs/$orgSlug/workflows")({
  component: WorkflowsList,
})

const STATUS_VARIANTS: Record<WorkflowStatus, "success" | "warning" | "destructive" | "outline"> = {
  healthy: "success",
  degraded: "warning",
  failing: "destructive",
  paused: "outline",
}

function WorkflowsList() {
  const { orgSlug } = Route.useParams()
  const workflows = useWorkflows(orgSlug)
  const projects = useProjects(orgSlug)
  const workflowProjects = projects.data?.filter(isStandaloneWorkflowProject)
  const count = workflowProjects?.length
  const isPending = workflows.isPending || projects.isPending
  const isError = workflows.isError || projects.isError
  const isEmpty = workflowProjects?.length === 0 && workflows.data?.length === 0

  return (
    <>
      <PageHeader title="Workflows" count={count}>
        <NewProjectDialog orgSlug={orgSlug} kind="workflow" triggerLabel="New workflow" />
      </PageHeader>

      <PageBody>
        {isPending && <ListSkeleton rows={3} />}

        {isError && (
          <ListError
            title="Could not load workflows"
            onRetry={() => {
              void workflows.refetch()
              void projects.refetch()
            }}
          />
        )}

        {isEmpty && (
          <EmptyState className="my-6">
            <EmptyStateIcon />
            <EmptyStateTitle>Nothing here yet</EmptyStateTitle>
            <EmptyStateDescription>
              Create a repository-backed interval or webhook workflow with the agent.
            </EmptyStateDescription>
            <EmptyStateActions>
              <NewProjectDialog orgSlug={orgSlug} kind="workflow" triggerLabel="New workflow" />
            </EmptyStateActions>
          </EmptyState>
        )}

        {workflowProjects !== undefined && workflowProjects.length > 0 && (
          <section aria-labelledby="workflow-repositories" className="flex flex-col gap-2">
            <h2
              id="workflow-repositories"
              className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              Workflow repositories
            </h2>
            {workflowProjects.map((project) => (
              <ProjectRow key={project.id} orgSlug={orgSlug} project={project} />
            ))}
          </section>
        )}

        {workflows.data !== undefined && workflows.data.length > 0 && (
          <section aria-labelledby="workflow-definitions" className="flex flex-col gap-2">
            <h2
              id="workflow-definitions"
              className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              Definitions
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="hidden sm:table-cell">Project</TableHead>
                  <TableHead className="w-32">Schedule</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="hidden w-32 lg:table-cell">Last run</TableHead>
                  <TableHead className="w-24 text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.data.map((workflow) => (
                  <TableRow key={workflow.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/orgs/$orgSlug/projects/$projectId/workflows/$workflowId"
                        params={{ orgSlug, projectId: workflow.projectId, workflowId: workflow.id }}
                        className="hover:underline"
                      >
                        {workflow.name}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {workflow.project}
                    </TableCell>
                    <TableCell numeric>{workflow.schedule}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[workflow.status]}>
                        {WORKFLOW_STATUS_LABELS[workflow.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {workflow.lastRunLabel}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money size="sm">{formatMicroUsd(workflow.costMicros)}</Money>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
      </PageBody>
    </>
  )
}
