import { createFileRoute } from "@tanstack/react-router"
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
import { PlugIcon } from "lucide-react"
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@ui/base/ui/empty-state"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import {
  type Disposition,
  type Grant,
  grantDate,
  scopeLabel,
  useOauthGrants,
  useRevokeGrant,
} from "@frontends/dashboard/data/oauth-grants"

export const Route = createFileRoute("/orgs/$orgSlug/settings/connected-apps")({
  component: ConnectedApps,
})

type KeptUri = { id: string; name: string; kind: string; connectionUri: string }

function ConnectedApps() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useOauthGrants(orgSlug)
  const revoke = useRevokeGrant(orgSlug)

  /*
    The grant being revoked, and the choice made for each of its databases.

    Held here rather than in the dialog so that closing and reopening starts from nothing. A
    half-remembered set of decisions is worse than none: the dialog is the only place these are
    shown, and reopening it with stale answers pre-selected is how somebody deletes a database they
    had decided to keep.
  */
  const [revoking, setRevoking] = useState<Grant | null>(null)
  const [choices, setChoices] = useState<Record<string, Disposition>>({})
  const [kept, setKept] = useState<KeptUri[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const grants = (data?.data ?? []) as Grant[]

  function open(grant: Grant) {
    setRevoking(grant)
    // Every database starts as "keep". The destructive answer should be one somebody chooses.
    setChoices(Object.fromEntries(grant.services.map((service) => [service.id, "keep" as const])))
    setError(null)
  }

  function submit() {
    if (revoking === null) return
    setError(null)
    revoke.mutate(
      {
        path: { orgSlug, grantId: revoking.id },
        body: {
          services: revoking.services.map((service) => ({
            id: service.id,
            action: choices[service.id] ?? "keep",
          })),
        },
      },
      {
        onSuccess: (result) => {
          setRevoking(null)
          const list = (result as { kept?: KeptUri[] }).kept ?? []
          // Only worth a dialog if there is something that can never be shown again.
          setKept(list.length > 0 ? list : null)
        },
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : "That did not work. Try again.")
        },
      },
    )
  }

  return (
    <PageBody>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Connected applications</h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          Applications you have signed into with SproutOS. Revoking one stops it calling the API on
          your behalf — and, because an application can create databases for you, asks what should
          happen to each one it made.
        </p>
      </div>

      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ListError onRetry={() => void refetch()} />
      ) : grants.length === 0 ? (
        <EmptyState className="mt-4">
          <EmptyStateIcon>
            <PlugIcon />
          </EmptyStateIcon>
          <EmptyStateTitle>Nothing connected</EmptyStateTitle>
          <EmptyStateDescription>
            When you sign into another service with SproutOS, it will appear here.
          </EmptyStateDescription>
        </EmptyState>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="rule-soft flex items-start justify-between gap-4 rounded-md border p-3"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{grant.clientName}</span>
                  {grant.firstParty ? <Badge variant="muted">SproutOS</Badge> : null}
                </div>

                {grant.clientHomepage === null ? null : (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {grant.clientHomepage}
                  </span>
                )}

                <div className="flex flex-wrap gap-1.5">
                  {grant.scopes.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scopeLabel(scope)}
                    </Badge>
                  ))}
                </div>

                <span className="text-xs text-muted-foreground">
                  Connected {grantDate(grant.createdAt)}
                  {grant.services.length > 0
                    ? ` · created ${grant.services.length} database${grant.services.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  open(grant)
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/*
        One dialog for the whole revocation, listing every database.

        Not a confirm-then-decide flow: the decision *is* the confirmation, and a person who has
        just been shown that this application made four databases is in a much better position to
        say "yes, revoke" than one who has already clicked through a generic warning.
      */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(next) => {
          if (!next) setRevoking(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.clientName}</DialogTitle>
            <DialogDescription>
              It will no longer be able to act on your behalf. Any tokens it holds stop working
              immediately.
            </DialogDescription>
          </DialogHeader>

          {revoking !== null && revoking.services.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                This application created the databases below. Choose what happens to each.
              </p>

              <ul className="flex flex-col gap-2">
                {revoking.services.map((service) => (
                  <li
                    key={service.id}
                    className="rule-soft flex items-center justify-between gap-3 rounded-md border p-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">{service.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {service.kind}
                      </span>
                    </div>

                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant={choices[service.id] === "keep" ? "default" : "outline"}
                        onClick={() => {
                          setChoices((current) => ({ ...current, [service.id]: "keep" }))
                        }}
                      >
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant={choices[service.id] === "delete" ? "destructive" : "outline"}
                        onClick={() => {
                          setChoices((current) => ({ ...current, [service.id]: "delete" }))
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>

              <Alert>
                <AlertDescription className="text-xs">
                  Keeping a database gives it a new connection URI, shown once. The old one stops
                  working — it is the credential this application was using.
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              This application did not create any databases.
            </p>
          )}

          {error === null ? null : <p className="mt-3 text-xs text-destructive">{error}</p>}

          <DialogFooter className="mt-6">
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => {
                submit()
              }}
            >
              {revoke.isPending ? "Revoking…" : "Revoke access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        The new URIs, once.

        Shown after the revocation rather than before, because until it succeeds there is nothing to
        show — and a URI displayed for a rotation that then failed would be a credential that does
        not exist.
      */}
      <Dialog
        open={kept !== null}
        onOpenChange={(next) => {
          if (!next) setKept(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New connection details</DialogTitle>
            <DialogDescription>
              These databases are yours now. Each has a new URI, and this is the only time it is
              shown.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-3">
            {(kept ?? []).map((service) => (
              <div key={service.id} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {service.name} · {service.kind}
                </span>
                <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs break-all">
                  {service.connectionUri}
                </pre>
              </div>
            ))}
          </div>

          <DialogFooter className="mt-6">
            <DialogClose render={<Button>Done</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  )
}
