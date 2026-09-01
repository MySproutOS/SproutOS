"use client"

import { useState } from "react"
import { Button } from "@ui/base/ui/button"
import { Checkbox } from "@ui/base/ui/checkbox"
import { deniedAuthorizationRedirect } from "./consent-redirect"

/**
 * What the person actually decides, and the only screen where they can.
 *
 * Two things are load-bearing here and neither is visual. The scopes are rendered one per line
 * rather than as prose, because a sentence is where "and manage your billing" hides. And *deny*
 * sends the browser back to the application with `error=access_denied` rather than doing nothing —
 * an application left hanging on a page the user closed cannot tell refusal from a network
 * failure, and will usually retry.
 */

type Client = {
  id: string
  name: string
  description: string | null
  logoUrl: string | null
  homepageUrl: string
  trusted: boolean
}

/**
 * `resource:action` split for display.
 *
 * The catalogue lives in the API's RBAC module and is not importable from here, which is fine: the
 * grammar is the contract and the two halves are more readable apart than a raw `project:delete`.
 */
function describe(scope: string): { resource: string; action: string } {
  const [resource, action] = scope.split(":")
  return { resource: resource ?? scope, action: action ?? "" }
}

export function ConsentForm({
  client,
  organizations,
  scopes,
  optionalScopes,
  databaseIntent,
  redirectUri,
  state,
  codeChallenge,
  codeChallengeMethod,
  userName,
  apiBase,
}: {
  client: Client
  organizations: { id: string; name: string; slug: string; availableCredit: string }[]
  scopes: string[]
  optionalScopes: string[]
  databaseIntent: boolean
  redirectUri: string
  state: string | null
  codeChallenge: string
  codeChallengeMethod: string
  userName: string
  /** Resolved on the server — see the note in `page.tsx` about build-time inlining. */
  apiBase: string
}) {
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [grantedOptionalScopes, setGrantedOptionalScopes] = useState<string[]>([])
  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  )

  const mandatoryScopes = scopes.filter((scope) => !optionalScopes.includes(scope))
  const grantedScopes = [...mandatoryScopes, ...grantedOptionalScopes]

  function deny() {
    window.location.assign(deniedAuthorizationRedirect(redirectUri, state))
  }

  async function approve() {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`${apiBase}/v1/oauth/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The session cookie is the authorization for this call; the API is a different origin
        // and will not send it otherwise.
        credentials: "include",
        body: JSON.stringify({
          clientId: client.id,
          redirectUri,
          scopes: grantedScopes,
          state,
          codeChallenge,
          codeChallengeMethod,
          organizationId,
        }),
      })

      const body = (await response.json()) as { redirectTo?: string; error_description?: string }

      if (!response.ok || body.redirectTo === undefined) {
        setError(body.error_description ?? "That request was refused.")
        setBusy(false)
        return
      }

      window.location.assign(body.redirectTo)
    } catch {
      setError("Could not reach SproutOS. Nothing was granted.")
      setBusy(false)
    }
  }

  return (
    <main className="container-page flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-lg rounded-2xl border rule-soft bg-card/60 p-8">
        <p className="eyebrow mb-4">Authorize application</p>

        <div className="flex items-start gap-4">
          {client.logoUrl !== null &&
            client.logoUrl !== "" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={client.logoUrl}
                alt=""
                className="size-12 shrink-0 rounded-lg border rule-soft object-cover"
              />
            )}
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-balance">
              {client.name}
            </h1>
            <a
              href={client.homepageUrl}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="mt-1 block truncate text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {client.homepageUrl}
            </a>
          </div>
        </div>

        {client.description !== null && client.description !== "" && (
          <p className="mt-4 text-sm text-muted-foreground text-pretty">{client.description}</p>
        )}

        {!client.trusted && (
          /*
            Said plainly rather than hidden behind an icon. Anyone can register an application and
            call it anything, including our own name — this line is the only thing standing between
            a convincing name and a person's assumption that SproutOS vetted it.
          */
          <p className="mt-4 rounded-lg border border-husk/30 bg-husk/5 px-3 py-2 text-xs text-muted-foreground text-pretty">
            This application was registered by a third party. SproutOS has not reviewed it — approve
            it only if you know who made it.
          </p>
        )}

        <p className="mt-6 text-sm">
          Signed in as <span className="font-medium">{userName}</span>. It will be able to:
        </p>

        <ul className="mt-3 flex flex-col gap-1.5">
          {mandatoryScopes.map((scope) => {
            const { resource, action } = describe(scope)
            return (
              <li key={scope} className="flex items-baseline gap-2 text-sm">
                <span aria-hidden="true" className="text-muted-foreground">
                  •
                </span>
                <span>
                  <span className="font-medium">{action || scope}</span>
                  {action !== "" && <span className="text-muted-foreground"> your {resource}</span>}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{scope}</span>
                </span>
              </li>
            )
          })}
        </ul>

        {databaseIntent && optionalScopes.includes("database:create") && (
          <div className="mt-5 rounded-lg border rule-soft bg-background/40 p-4">
            <div className="flex items-start gap-3">
              <Checkbox
                id="database-create"
                checked={grantedOptionalScopes.includes("database:create")}
                onCheckedChange={(checked) => {
                  setGrantedOptionalScopes(checked ? ["database:create"] : [])
                }}
              />
              <div className="flex flex-col gap-1">
                <label htmlFor="database-create" className="text-sm font-medium">
                  Allow this application to create a database
                </label>
                <p className="text-xs text-muted-foreground text-pretty">
                  Optional. Creating and running a database uses your SproutOS credit. You can
                  continue without database access, and permission alone does not charge you.
                </p>
                {selectedOrganization !== undefined && (
                  <p className="text-xs text-muted-foreground text-pretty">
                    <span className="font-medium text-foreground">
                      {selectedOrganization.availableCredit} available
                    </span>{" "}
                    for {selectedOrganization.name}.{" "}
                    <a
                      href={`/orgs/${selectedOrganization.slug}/settings/billing`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      View billing
                    </a>
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <p className="mt-4 text-xs text-muted-foreground text-pretty">
          It can never do more than you can. Anything you are not permitted to do yourself stays
          refused even when granted here.
        </p>

        {organizations.length > 1 && (
          <div className="mt-6 flex flex-col gap-1.5">
            <label htmlFor="organizationId" className="text-sm font-medium">
              Team
            </label>
            <select
              id="organizationId"
              value={organizationId}
              onChange={(event) => {
                setOrganizationId(event.target.value)
              }}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error !== null && (
          <p className="mt-5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" type="button" onClick={deny} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void approve()} disabled={busy}>
            {busy ? "Authorizing…" : `Authorize ${client.name}`}
          </Button>
        </div>

        <p className="mt-6 text-xs text-muted-foreground text-pretty">
          You can revoke this at any time from your team's settings.
        </p>
      </div>
    </main>
  )
}
