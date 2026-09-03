/*
 * The provider rows deliberately close over their provider/identity, and Base UI requires JSX in
 * DialogClose's render prop. These are interactive leaf controls rather than memoized child APIs.
 */
/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop */
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
import { KeyRoundIcon } from "lucide-react"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import {
  signInMethodDate,
  useBeginSignInMethodAuthorization,
  useSignInMethods,
  useUnlinkSignInMethod,
} from "@frontends/dashboard/data/sign-in-methods"

type Provider = "google" | "github"
type Method = {
  id: string
  provider: Provider
  displayIdentity: string
  connectedAt: Date
  repositoryAccessNeedsReauthorization: boolean
  canUnlink: boolean
}

export const SIGN_IN_METHODS_ROUTE_PATH = "/orgs/$orgSlug/settings/sign-in-methods" as const

export const Route = createFileRoute("/orgs/$orgSlug/settings/sign-in-methods")({
  validateSearch: (search: Record<string, unknown>) => ({
    sign_in_method:
      search.sign_in_method === "linked" ||
      search.sign_in_method === "reauthorized" ||
      search.sign_in_method === "conflict"
        ? search.sign_in_method
        : undefined,
  }),
  component: SignInMethods,
})

const PROVIDERS: Array<{ provider: Provider; label: string }> = [
  { provider: "google", label: "Google" },
  { provider: "github", label: "GitHub" },
]

export function signInMethodPresentation(method: Method) {
  return {
    displayIdentity: method.displayIdentity,
    connected: signInMethodDate(method.connectedAt),
    status: method.repositoryAccessNeedsReauthorization
      ? "Repository access needs reauthorization"
      : "Connected",
    canUnlink: method.canUnlink,
  }
}

export function SignInMethodEntry({
  label,
  method,
  busy,
  onReauthorize,
  onUnlink,
}: {
  label: string
  method: Method
  busy: boolean
  onReauthorize: () => void
  onUnlink: () => void
}) {
  const presentation = signInMethodPresentation(method)
  return (
    <div className="rule-soft flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{label}</p>
          {method.repositoryAccessNeedsReauthorization ? (
            <Badge variant="outline">{presentation.status}</Badge>
          ) : (
            <Badge variant="muted">{presentation.status}</Badge>
          )}
        </div>
        <p className="mt-1 truncate text-sm">{presentation.displayIdentity}</p>
        <p className="mt-1 text-xs text-muted-foreground">Connected {presentation.connected}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onReauthorize}>
          Reauthorize
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!presentation.canUnlink || busy}
          title={
            presentation.canUnlink ? undefined : "Link another sign-in method before unlinking"
          }
          onClick={onUnlink}
        >
          Unlink
        </Button>
      </div>
    </div>
  )
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return "That request was refused. Sign in again and retry."
}

function SignInMethods() {
  const { orgSlug } = Route.useParams()
  const { sign_in_method: result } = Route.useSearch()
  const methods = useSignInMethods()
  const authorize = useBeginSignInMethodAuthorization()
  const unlink = useUnlinkSignInMethod()
  const [selected, setSelected] = useState<Method | null>(null)
  const [error, setError] = useState<string | null>(null)
  const returnTo = `/orgs/${encodeURIComponent(orgSlug)}/settings/sign-in-methods`

  function begin(provider: Provider, method?: Method) {
    setError(null)
    authorize.mutate(
      {
        body: {
          provider,
          intent: method === undefined ? "link" : "reauthorize",
          ...(method === undefined ? {} : { methodId: method.id }),
          returnTo,
        },
      },
      {
        onError: (cause) => {
          setError(message(cause))
        },
      },
    )
  }

  const connected = (methods.data?.data ?? []) as Method[]

  return (
    <PageBody>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Sign-in methods</h2>
        <p className="max-w-2xl text-xs text-muted-foreground">
          Google and GitHub accounts you can use to sign in to your personal SproutOS account. These
          are separate from OAuth applications you authorize and GitHub App installations owned by a
          team.
        </p>
      </div>

      {error !== null ? (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            {error}{" "}
            <a
              className="font-medium underline underline-offset-4"
              href={`/login?next=${encodeURIComponent(returnTo)}`}
            >
              Sign in again
            </a>
          </AlertDescription>
        </Alert>
      ) : null}

      {result === "linked" || result === "reauthorized" ? (
        <Alert className="mt-4">
          <AlertDescription>
            Sign-in method {result === "linked" ? "linked" : "reauthorized"} successfully.
          </AlertDescription>
        </Alert>
      ) : result === "conflict" ? (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            That provider identity already belongs to another SproutOS account. No accounts were
            merged or changed.
          </AlertDescription>
        </Alert>
      ) : null}

      {methods.isPending ? (
        <ListSkeleton />
      ) : methods.isError ? (
        <ListError onRetry={() => void methods.refetch()} />
      ) : (
        <div className="mt-4 flex max-w-2xl flex-col gap-2">
          {PROVIDERS.map(({ provider, label }) => {
            const providerMethods = connected.filter((method) => method.provider === provider)
            if (providerMethods.length === 0) {
              return (
                <div
                  key={provider}
                  className="rule-soft flex items-center justify-between gap-4 rounded-md border p-3"
                >
                  <div className="flex items-center gap-3">
                    <KeyRoundIcon className="size-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">Not linked</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={authorize.isPending}
                    onClick={() => {
                      begin(provider)
                    }}
                  >
                    Link
                  </Button>
                </div>
              )
            }

            return providerMethods.map((method) => (
              <SignInMethodEntry
                key={method.id}
                label={label}
                method={method}
                busy={authorize.isPending || unlink.isPending}
                onReauthorize={() => {
                  begin(provider, method)
                }}
                onUnlink={() => {
                  setSelected(method)
                }}
              />
            ))
          })}
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlink {selected?.displayIdentity}</DialogTitle>
            <DialogDescription>
              You will no longer be able to use this identity to sign in. Existing sessions on other
              devices stay signed in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              disabled={unlink.isPending}
              onClick={() => {
                if (selected === null) return
                setError(null)
                unlink.mutate(
                  { path: { methodId: selected.id }, body: { confirmation: "UNLINK" } },
                  {
                    onSuccess: () => {
                      setSelected(null)
                    },
                    onError: (cause) => {
                      setSelected(null)
                      setError(message(cause))
                    },
                  },
                )
              }}
            >
              Unlink
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  )
}
