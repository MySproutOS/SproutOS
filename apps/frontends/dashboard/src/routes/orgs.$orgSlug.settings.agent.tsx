import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
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
  DialogTrigger,
} from "@ui/base/ui/dialog"
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { PlusIcon, TrashIcon } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import {
  CREDENTIAL_KINDS,
  type CredentialKind,
  useAgentCredentials,
  useCreateAgentCredential,
  useRevokeAgentCredential,
} from "@frontends/dashboard/data/agent-credentials"

export const Route = createFileRoute("/orgs/$orgSlug/settings/agent")({
  component: AgentSettings,
})

function AgentSettings() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useAgentCredentials(orgSlug)
  const revoke = useRevokeAgentCredential(orgSlug)

  return (
    <PageBody>
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">Model credentials</h2>
        {data !== undefined && data.length > 0 && <AddCredentialDialog orgSlug={orgSlug} />}
      </div>

      <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
        The agent runs on your own model access. Nothing here is shared between organizations, and
        the secret is sealed before it reaches the database — it is never shown again after you add
        it.
      </p>

      {isPending && <ListSkeleton rows={2} />}
      {isError && (
        <ListError
          title="Could not load model credentials"
          onRetry={() => {
            void refetch()
          }}
        />
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState className="my-6">
          <EmptyStateIcon />
          <EmptyStateTitle>No model credential</EmptyStateTitle>
          <EmptyStateDescription>
            Agent chat and fork upkeep both need one. Without it they answer &ldquo;No model
            credential configured&rdquo;.
          </EmptyStateDescription>
          <EmptyStateActions>
            <AddCredentialDialog orgSlug={orgSlug} />
          </EmptyStateActions>
        </EmptyState>
      )}

      {data !== undefined && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead className="w-48">Kind</TableHead>
              <TableHead className="w-28">Secret</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((credential) => (
              <TableRow key={credential.id}>
                <TableCell className="font-medium">
                  {credential.label}
                  {credential.revokedAt !== null && (
                    <Badge variant="muted" className="ml-2">
                      Revoked
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  {credential.kindLabel}
                </TableCell>
                <TableCell className="tnum font-mono text-xs text-muted-foreground">
                  {/* The last four, which is all the API returns and all anyone needs to tell two
                      credentials apart. */}
                  {credential.lastFour === null ? "—" : `…${credential.lastFour}`}
                </TableCell>
                <TableCell>
                  {credential.revokedAt === null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke ${credential.label}`}
                      onClick={() => {
                        revoke.mutate({
                          path: { orgSlug, credentialId: credential.id },
                        })
                      }}
                    >
                      <TrashIcon />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageBody>
  )
}

function AddCredentialDialog({ orgSlug }: { orgSlug: string }) {
  const create = useCreateAgentCredential(orgSlug)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<CredentialKind>("claude_subscription")
  const [label, setLabel] = useState("")
  const [secret, setSecret] = useState("")

  const selected = CREDENTIAL_KINDS.find((entry) => entry.kind === kind)

  function onSubmit() {
    create.mutate(
      { path: { orgSlug }, body: { kind, label, secret } },
      {
        onSuccess: () => {
          // Cleared on the way out, not on the way in. The secret sits in this component's state
          // for as long as the dialog is open, and leaving it there after a successful save would
          // keep a credential in memory for the life of the page.
          setSecret("")
          setLabel("")
          setOpen(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            Add credential
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a model credential</DialogTitle>
          <DialogDescription>
            Sealed with the platform key before it is stored. You will not be able to read it back.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-kind">Kind</Label>
            <select
              id="credential-kind"
              className="h-8 rounded-md border border-border bg-transparent px-2 text-[13px]"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CredentialKind)
              }}
            >
              {CREDENTIAL_KINDS.map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
            </select>
            {selected !== undefined && (
              <p className="text-[11px] text-muted-foreground">{selected.hint}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-label">Label</Label>
            <Input
              id="credential-label"
              value={label}
              placeholder="Team Claude"
              onChange={(event) => {
                setLabel(event.target.value)
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-secret">Secret</Label>
            <Input
              id="credential-secret"
              // `password`, so it is not shoulder-read and not captured by a screen recording.
              type="password"
              autoComplete="off"
              value={secret}
              placeholder="sk-…"
              onChange={(event) => {
                setSecret(event.target.value)
              }}
            />
          </div>

          {create.isError && (
            <ListError
              title="Could not add this credential"
              detail={create.error.error?.message ?? "The server did not say why."}
            />
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            disabled={label.trim() === "" || secret.length < 8 || create.isPending}
            onClick={onSubmit}
          >
            {create.isPending ? "Adding…" : "Add credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
