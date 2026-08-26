import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugOauthGrantsOptions,
  getV1OrgsByOrgSlugOauthGrantsQueryKey,
  postV1OrgsByOrgSlugOauthGrantsByGrantIdRevokeMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/** What happens to one database when the application that created it loses access. */
export type Disposition = "keep" | "delete"

export type GrantService = {
  id: string
  name: string
  kind: string
  status: string
  createdAt: string
}

export type Grant = {
  id: string
  clientId: string
  clientName: string
  clientHomepage: string | null
  firstParty: boolean
  scopes: string[]
  createdAt: string
  services: GrantService[]
}

/** The applications this person has authorized, and what each one created. */
export function useOauthGrants(orgSlug: string) {
  return useQuery(getV1OrgsByOrgSlugOauthGrantsOptions({ path: { orgSlug } }))
}

/**
 * Withdraw consent, having decided what happens to each database.
 *
 * The reply carries a new connection URI for every database kept, **once**. Nothing here caches or
 * stores it — the caller shows it and forgets it — because a live credential held in query state
 * for the rest of the session is a credential in a place nobody expects to find one.
 *
 * The databases list is invalidated too: kept ones now belong to the user, and deleted ones are
 * gone, and neither is true of what the page is currently showing.
 */
export function useRevokeGrant(orgSlug: string) {
  const client = useQueryClient()
  const mutation = postV1OrgsByOrgSlugOauthGrantsByGrantIdRevokeMutation()

  return useMutation({
    ...mutation,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthGrantsQueryKey({ path: { orgSlug } }),
      })
      // The Databases page is now wrong in both directions.
      await client.invalidateQueries({ queryKey: ["databases", orgSlug] })
    },
  })
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
})

export function grantDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso))
}

/**
 * A scope as a person would read it.
 *
 * The catalogue is `service:action` and that is right for a policy document and wrong for a consent
 * screen — "database:create" is what the system checks, and "Create databases" is what somebody is
 * being asked to agree to. Anything unrecognised falls back to the raw string rather than being
 * hidden: a scope nobody wrote a label for is still a permission the application has.
 */
const SCOPE_LABELS: Record<string, string> = {
  "database:create": "Create databases",
  "database:read": "See your databases",
  "database:delete": "Delete databases",
  "project:read": "See your projects",
  "project:create": "Create projects",
  "project:delete": "Delete projects",
  "observability:logs:read": "Read your logs",
}

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}
