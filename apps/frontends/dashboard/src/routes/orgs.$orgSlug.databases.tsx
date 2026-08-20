import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
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
  DATABASE_STATUS_LABELS,
  ENGINE_LABELS,
  useDatabases,
  type DatabaseStatus,
} from "@frontends/dashboard/data/databases"

export const Route = createFileRoute("/orgs/$orgSlug/databases")({
  component: DatabasesList,
})

const STATUS_VARIANTS: Record<DatabaseStatus, "success" | "warning" | "outline"> = {
  ready: "success",
  provisioning: "warning",
  sleeping: "outline",
}

function DatabasesList() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useDatabases(orgSlug)

  return (
    <>
      <PageHeader title="Databases" count={data?.length} />

      <PageBody>
        {isPending && <ListSkeleton rows={3} />}

        {isError && (
          <ListError
            title="Could not load databases"
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
              A database is provisioned when a project declares one.
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
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Engine</TableHead>
                <TableHead className="hidden sm:table-cell">Project</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="hidden w-24 lg:table-cell">Size</TableHead>
                <TableHead className="hidden w-28 lg:table-cell">Region</TableHead>
                <TableHead className="w-24 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((database) => (
                <TableRow key={database.id}>
                  <TableCell numeric className="text-foreground">
                    {database.name}
                  </TableCell>
                  <TableCell>{ENGINE_LABELS[database.engine]}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {database.project}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[database.status]}>
                      {DATABASE_STATUS_LABELS[database.status]}
                    </Badge>
                  </TableCell>
                  <TableCell numeric className="hidden lg:table-cell">
                    {database.size}
                  </TableCell>
                  <TableCell numeric className="hidden lg:table-cell">
                    {database.region}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money size="sm">{formatMicroUsd(database.costMicros)}</Money>
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
