import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Alert, AlertDescription } from "@ui/base/ui/alert"
import { Badge } from "@ui/base/ui/badge"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui/base/ui/dialog"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
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
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "@frontends/dashboard/data/members"

export const Route = createFileRoute("/orgs/$orgSlug/settings/api-keys")({
  component: ApiKeysSettings,
})

function ApiKeysSettings() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useApiKeys(orgSlug)
  const revoke = useRevokeApiKey(orgSlug)

  return (
    <PageBody>
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">API keys</h2>
        <CreateKeyDialog orgSlug={orgSlug} />
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
            <CreateKeyDialog orgSlug={orgSlug} />
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
                <TableCell className="font-medium">
                  {key.name}
                  {/*
                    The scopes belong next to the name. A key called "CI" tells you nothing about
                    what it can do, and what it can do is the thing worth auditing.
                  */}
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {key.scopes.length === 0 ? "no scopes" : key.scopes.join(" ")}
                  </span>
                </TableCell>
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
                          disabled={revoke.isPending}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            revoke.mutate({ path: { orgSlug, apiKeyId: key.id } })
                          }}
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

/**
 * Minting a key.
 *
 * The secret is shown once and never again — it is stored as a one-way hash, so there is no route
 * that could return it. The dialog says so, because a user who assumes they can come back for it
 * will not write it down.
 */
function CreateKeyDialog(props: { orgSlug: string }) {
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState("*")
  const [issued, setIssued] = useState<string | null>(null)
  const create = useCreateApiKey(props.orgSlug)

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) return
        // Cleared on close so a live credential does not sit in component state for the session.
        setIssued(null)
        setName("")
        setScopes("*")
        create.reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            Create key
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an API key</DialogTitle>
          <DialogDescription>
            A key acts as you. It can never do more than you can — if your permissions change, so do
            its.
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                placeholder="CI import"
                onChange={(event) => {
                  setName(event.target.value)
                }}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="key-scopes">Scopes</Label>
              <Input
                id="key-scopes"
                value={scopes}
                placeholder="project:read workflow:run"
                onChange={(event) => {
                  setScopes(event.target.value)
                }}
                className="mt-1 font-mono"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Space separated. <span className="font-mono">*</span> means everything you can do.
              </p>
            </div>
            {create.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {(create.error as { error?: { message?: string } } | undefined)?.error?.message ??
                    "The key could not be created"}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : (
          <div>
            <Label className="text-xs text-muted-foreground">
              Copy it now — it is not shown again
            </Label>
            <p className="rule-soft mt-1 break-all rounded-md border px-2 py-1.5 font-mono text-xs">
              {issued}
            </p>
            <Badge variant="outline" className="mt-2">
              Stored hashed. Create a new one if you lose it.
            </Badge>
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Close</Button>} />
          {issued === null ? (
            <Button
              disabled={create.isPending || name.trim() === ""}
              onClick={() => {
                create.mutate(
                  {
                    path: { orgSlug: props.orgSlug },
                    body: {
                      name: name.trim(),
                      scopes: scopes.trim().split(/\s+/).filter(Boolean),
                    },
                  },
                  {
                    onSuccess: (data) => {
                      setIssued(data.key)
                    },
                  },
                )
              }}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
