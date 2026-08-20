import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
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
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
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
  const { data, isPending, isError, refetch } = useWorkflows(orgSlug)

  return (
    <>
      <PageHeader title="Workflows" count={data?.length}>
        <Button render={<Link to="/store" />}>
          <PlusIcon />
          New workflow
        </Button>
      </PageHeader>

      <PageBody>
        {isPending && <ListSkeleton rows={3} />}

        {isError && (
          <ListError
            title="Could not load workflows"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {data !== undefined && data.length === 0 && (
          <EmptyState className="my-6">
            <EmptyStateIcon />
            <EmptyStateTitle>Nothing here yet</EmptyStateTitle>
            <EmptyStateDescription>
              Workflows arrive with the app you fork. Start from one that already works.
            </EmptyStateDescription>
            <EmptyStateActions>
              <Button render={<Link to="/store" />}>Go to store</Button>
            </EmptyStateActions>
          </EmptyState>
        )}

        {data !== undefined && data.length > 0 && (
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
              {data.map((workflow) => (
                <TableRow key={workflow.id}>
                  <TableCell className="font-medium">{workflow.name}</TableCell>
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
        )}
      </PageBody>
    </>
  )
}
