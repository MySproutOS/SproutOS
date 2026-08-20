import { createFileRoute } from "@tanstack/react-router"
import { PlusIcon, TrashIcon } from "lucide-react"
import { Button } from "@ui/base/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/base/ui/tooltip"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import { useApiKeys } from "@frontends/dashboard/data/members"

export const Route = createFileRoute("/orgs/$orgSlug/settings/api-keys")({
  component: ApiKeysSettings,
})

function ApiKeysSettings() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useApiKeys(orgSlug)

  return (
    <PageBody>
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">API keys</h2>
        <Button size="sm">
          <PlusIcon />
          Create key
        </Button>
      </div>

      {isPending && <ListSkeleton rows={2} />}
      {isError && (
        <ListError
          title="Could not load API keys"
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
            An API key lets a script talk to this organization without a browser session.
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button>Create key</Button>
          </EmptyStateActions>
        </EmptyState>
      )}

      {data !== undefined && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-44">Key</TableHead>
              <TableHead className="hidden w-28 sm:table-cell">Created</TableHead>
              <TableHead className="hidden w-32 lg:table-cell">Last used</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell numeric>{key.prefix}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {key.createdLabel}
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {key.lastUsedLabel ?? "Never"}
                </TableCell>
                <TableCell className="text-right">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Revoke ${key.name}`}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <TrashIcon />
                        </Button>
                      }
                    />
                    <TooltipContent>Revoke</TooltipContent>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageBody>
  )
}
