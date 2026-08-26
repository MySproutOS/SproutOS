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
import { Textarea } from "@ui/base/ui/textarea"
import { KeyRoundIcon, PlusIcon } from "lucide-react"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import {
  useCreateOauthClient,
  useOauthClients,
  useSetOauthClientStatus,
} from "@frontends/dashboard/data/oauth-clients"
import { ClientSecrets } from "@frontends/dashboard/components/oauth/client-secrets"

export const Route = createFileRoute("/orgs/$orgSlug/settings/oauth-clients")({
  component: OauthClientsSettings,
})

/**
 * Registering an application against SproutOS's own OAuth provider.
 *
 * This is the half of the provider a person touches. The endpoints have existed and been tested
 * since the provider was built; until now there was no way to create a client without `curl`, which
 * made a working identity provider unusable by the people it was for.
 */
function OauthClientsSettings() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useOauthClients(orgSlug)
  const status = useSetOauthClientStatus(orgSlug)

  if (isPending) return <ListSkeleton />
  if (isError) return <ListError onRetry={() => void refetch()} />

  const clients = data ?? []

  return (
    <PageBody>
      <div className="flex items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-lg font-semibold tracking-tight">OAuth applications</h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Let people sign in to your own application with their SproutOS account. An application
            can only ever be granted permissions the person approving it already holds.
          </p>
        </div>
        <CreateClientDialog orgSlug={orgSlug} />
      </div>

      {clients.length === 0 ? (
        <EmptyState className="mt-8">
          <EmptyStateIcon>
            <KeyRoundIcon />
          </EmptyStateIcon>
          <EmptyStateTitle>No applications yet</EmptyStateTitle>
          <EmptyStateDescription>
            Register one to sign people in with SproutOS.
          </EmptyStateDescription>
          <EmptyStateActions>
            <CreateClientDialog orgSlug={orgSlug} />
          </EmptyStateActions>
        </EmptyState>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {clients.map((client) => (
            <li key={client.id} className="rounded-xl border bg-card/60 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{client.name}</h3>
                    {/* `public` is not a lesser tier — it is a client that ships its own source and
                        therefore must never hold a secret. Saying so on the row keeps the missing
                        "new secret" button from reading as a bug. */}
                    <Badge variant={client.isPublic ? "muted" : "outline"}>
                      {client.isPublic ? "Public — PKCE only" : "Confidential"}
                    </Badge>
                    {client.isVerified && <Badge>Verified</Badge>}
                    {client.suspended && <Badge variant="destructive">Suspended</Badge>}
                  </div>
                  {client.description !== null && client.description !== "" && (
                    <p className="mt-1 text-sm text-muted-foreground text-pretty">
                      {client.description}
                    </p>
                  )}
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    client_id {client.id}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Redirects to {client.redirectUris.join(", ")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status.isPending}
                  onClick={() => {
                    status.mutate({
                      path: { orgSlug, clientId: client.id },
                      body: { status: client.suspended ? "active" : "suspended" },
                    })
                  }}
                >
                  {client.suspended ? "Reactivate" : "Suspend"}
                </Button>
              </div>

              {!client.isPublic && <ClientSecrets orgSlug={orgSlug} clientId={client.id} />}
            </li>
          ))}
        </ul>
      )}
    </PageBody>
  )
}

/**
 * One field, as a string.
 *
 * `FormData.get` returns `string | File | null`, and `String(file)` is `"[object Object]"` — which
 * would be submitted as the application's name without anything complaining. Reading only the
 * string case means a mistyped input yields an empty field the API rejects, rather than a plausible
 * one it accepts.
 */
function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

function CreateClientDialog({ orgSlug }: { orgSlug: string }) {
  const create = useCreateOauthClient(orgSlug)
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // The secret is cleared when the dialog closes rather than kept in state. There is no
        // endpoint that returns it again, so leaving it around only widens where it can be read
        // from.
        if (!next) setSecret(null)
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            New application
          </Button>
        }
      />
      <DialogContent>
        {secret === null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const clientType = field(form, "clientType") || "confidential"

              create.mutate(
                {
                  path: { orgSlug },
                  body: {
                    name: field(form, "name"),
                    homepageUrl: field(form, "homepageUrl"),
                    description: field(form, "description") || null,
                    clientType: clientType === "public" ? "public" : "confidential",
                    redirectUris: field(form, "redirectUris")
                      .split("\n")
                      .map((uri) => uri.trim())
                      .filter((uri) => uri !== ""),
                  },
                },
                {
                  onSuccess: (created) => {
                    /*
                      A string. The API used to answer with `{ id, secret, lastFour }` while its
                      schema declared a string, so this put an object into the `<pre>` below and
                      React refused to render it — error #31, on the one screen showing a value
                      that can never be fetched again. The handler matches its contract now.
                    */
                    setSecret(created.secret ?? null)
                    if (created.secret === undefined) setOpen(false)
                  },
                },
              )
            }}
          >
            <DialogHeader>
              <DialogTitle>New OAuth application</DialogTitle>
              <DialogDescription>
                People will see this name and homepage when they are asked to approve it.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-5 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Application name</Label>
                <Input id="name" name="name" required maxLength={120} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="homepageUrl">Homepage URL</Label>
                <Input
                  id="homepageUrl"
                  name="homepageUrl"
                  type="url"
                  required
                  placeholder="https://example.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" name="description" maxLength={500} rows={2} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="redirectUris">Redirect URIs, one per line</Label>
                <Textarea
                  id="redirectUris"
                  name="redirectUris"
                  required
                  rows={3}
                  placeholder={"https://example.com/callback\nhttp://localhost:3000/callback"}
                  className="font-mono text-xs"
                />
                {/* The rule is enforced by the API; stating it here turns a rejected submit into a
                    thing the developer already knew. */}
                <p className="text-xs text-muted-foreground text-pretty">
                  Must be https, or http on localhost, and must not contain a fragment. This is
                  where the authorization code is delivered, so anything looser is a way for it to
                  reach someone else.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clientType">Application type</Label>
                <select
                  id="clientType"
                  name="clientType"
                  defaultValue="confidential"
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="confidential">Confidential — a server keeps the secret</option>
                  <option value="public">Public — a browser or mobile app, PKCE only</option>
                </select>
                <p className="text-xs text-muted-foreground text-pretty">
                  Choose public if the application's code is downloaded by whoever runs it. It gets
                  no secret, because anything shipped to a user is not one.
                </p>
              </div>

              {create.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {create.error instanceof Error
                      ? create.error.message
                      : "That was not accepted. Check the redirect URIs."}
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <DialogFooter className="mt-6">
              <DialogClose
                render={
                  <Button variant="ghost" type="button">
                    Cancel
                  </Button>
                }
              />
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create application"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div>
            <DialogHeader>
              <DialogTitle>Copy the client secret now</DialogTitle>
              <DialogDescription>
                Only its hash is stored, so this cannot be shown again. If you lose it, issue a new
                one — that is not a workaround, it is the design.
              </DialogDescription>
            </DialogHeader>
            <pre className="mt-5 overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs break-all">
              {secret}
            </pre>
            <DialogFooter className="mt-6">
              <DialogClose render={<Button>Done</Button>} />
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
