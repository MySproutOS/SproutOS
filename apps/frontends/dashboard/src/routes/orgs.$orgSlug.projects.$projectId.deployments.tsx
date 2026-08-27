import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { Alert, AlertDescription } from "@ui/base/ui/alert"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/base/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { ArrowLeftIcon, ExternalLinkIcon, RotateCcwIcon } from "lucide-react"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import {
  canRollBackTo,
  type Deployment,
  useDeployments,
  useRollback,
} from "@frontends/dashboard/data/deployments"
import { useProject } from "@frontends/dashboard/data/projects"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/deployments")({
  component: Deployments,
})

/** Ready is the only success. Everything else is either in flight or a failure. */
const STATUS_VARIANT: Record<string, "success" | "outline" | "destructive"> = {
  ready: "success",
  error: "destructive",
  torn_down: "outline",
  queued: "outline",
  building: "outline",
  deploying: "outline",
}

function Deployments() {
  const { orgSlug, projectId } = Route.useParams()
  const project = useProject(orgSlug, projectId)
  const { data, isPending, isError, refetch } = useDeployments(orgSlug, projectId)
  const rollback = useRollback(orgSlug, projectId)

  const [target, setTarget] = useState<Deployment | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = data ?? []
  const liveId =
    project.data?.url === null ? null : (rows.find((row) => row.url !== null)?.id ?? null)

  function confirm() {
    if (target === null) return
    setError(null)
    rollback.mutate(
      { path: { orgSlug, deploymentId: target.id } },
      {
        onSuccess: () => {
          setTarget(null)
        },
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : "That did not work. Try again.")
        },
      },
    )
  }

  return (
    <>
      <PageHeader title="Deployments" count={rows.length}>
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId }} />}
        >
          <ArrowLeftIcon />
          {project.data?.name ?? "Overview"}
        </Button>
      </PageHeader>

      <PageBody>
        {isPending && <ListSkeleton />}
        {isError && (
          <ListError
            title="Could not load deployments"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {data !== undefined && rows.length === 0 && (
          <p className="rule-soft rounded-lg border px-3 py-10 text-center text-sm text-muted-foreground">
            No deployments yet.
          </p>
        )}

        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-24">Kind</TableHead>
                <TableHead className="w-28">Created</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-[12.5px]">
                        <span className="tnum font-mono">{row.shortSha}</span>
                        <span className="truncate text-muted-foreground">
                          {row.gitMessage ?? row.gitRef ?? ""}
                        </span>
                      </span>
                      {/*
                        The two failure reasons stay distinct.

                        "Your build would not build" and "it built and would not run" are different
                        problems with different owners, and collapsing them leaves a customer unable
                        to tell which half is theirs.
                      */}
                      {row.buildFailureReason === null ? null : (
                        <span className="text-[11.5px] text-destructive">
                          Build: {row.buildFailureReason}
                        </span>
                      )}
                      {row.failureReason === null ? null : (
                        <span className="text-[11.5px] text-destructive">{row.failureReason}</span>
                      )}
                      {row.migrationStatus === "failed" && row.migrationOutput !== null ? (
                        <details className="text-[11.5px] text-muted-foreground">
                          <summary className="cursor-pointer text-destructive">
                            Migration failed — show output
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap">
                            {row.migrationOutput}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell>
                    <span className="text-[12.5px] text-muted-foreground">{row.kind}</span>
                  </TableCell>

                  <TableCell>
                    <span className="text-[12.5px] text-muted-foreground">{row.createdLabel}</span>
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {row.url === null ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          render={
                            <a
                              href={row.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open deployment ${row.shortSha}`}
                            />
                          }
                        >
                          <ExternalLinkIcon />
                          <span className="sr-only">Open</span>
                        </Button>
                      )}
                      {canRollBackTo(row, liveId) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setTarget(row)
                            setError(null)
                          }}
                        >
                          <RotateCcwIcon />
                          Roll back
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>

      <Dialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) setTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roll back to {target?.shortSha}?</DialogTitle>
            <DialogDescription>
              {target?.preset === "static"
                ? "This points the site's edge route at that release. No rebuild — it takes effect immediately."
                : "This points the live alias at that release. No rebuild — it takes effect immediately."}
            </DialogDescription>
          </DialogHeader>

          {/*
            The one thing about rollback that surprises people.

            Environment variables are baked into a published version, so moving the alias moves the
            configuration with it — including a secret rotated since. Vercel behaves the same way and
            also does not say so, which is how it becomes an outage nobody can explain.
          */}
          {target?.preset === "static" ? null : (
            <Alert className="mt-4">
              <AlertDescription className="text-xs">
                The environment variables this release was published with come back too. If any have
                been rotated since, this reverts them.
              </AlertDescription>
            </Alert>
          )}

          {error === null ? null : <p className="mt-3 text-xs text-destructive">{error}</p>}

          <DialogFooter className="mt-6">
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button disabled={rollback.isPending} onClick={confirm}>
              {rollback.isPending ? "Rolling back…" : "Roll back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
