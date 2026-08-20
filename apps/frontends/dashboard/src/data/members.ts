import { useQuery } from "@tanstack/react-query"
import {
  getV1AuthMeOptions,
  getV1OrgsByOrgSlugMembersOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

export type Member = {
  id: string
  /** The API allows a null name; fall back to the email so a row is never blank. */
  name: string
  email: string
  isOwner: boolean
  /** Org-defined RBAC roles, so these are arbitrary strings, not a fixed enum. */
  roleNames: string[]
  joinedLabel: string
}

export type ApiKey = {
  id: string
  name: string
  prefix: string
  createdLabel: string
  lastUsedLabel: string | null
}

export type UserProfile = {
  name: string
  email: string
  timezone: string
  productEmails: boolean
}

const JOINED_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" })

/*
  The generated types say `createdAt: Date`, but this client has no
  `transformers.gen.ts` — every date arrives as an ISO string and the type is a
  lie. Formatting one directly throws `RangeError: Invalid time value`, so coerce
  at the boundary. Applies to every `Date`-typed field the API returns.
*/

export function useMembers(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugMembersOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((member): Member => ({
      id: member.id,
      name: member.name ?? member.email,
      email: member.email,
      isOwner: member.isOwner,
      // `isOwner` already renders an Owner badge; the API also lists a role
      // literally named "owner", which would render the same word twice.
      roleNames: member.roles
        .map((role) => role.name)
        .filter((name) => name.toLowerCase() !== "owner"),
      joinedLabel: JOINED_FORMAT.format(new Date(member.createdAt)),
    })),
  }
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugApiKeyOptions(...)`. */
export function useApiKeys(orgSlug: string) {
  const keys: ApiKey[] = [
    {
      id: "key_01j8ciimport",
      name: "CI import",
      prefix: "sk_live_9f2a…",
      createdLabel: "Mar 2026",
      lastUsedLabel: "2 hours ago",
    },
    {
      id: "key_01j8localdev",
      name: "Local dev",
      prefix: "sk_live_41cd…",
      createdLabel: "Jun 2026",
      lastUsedLabel: null,
    },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "api-keys"], keys)
}

/*
  `user_preference` has no endpoint yet, so these two fields stay fixtures while
  the identity beside them is real.
*/
const PLACEHOLDER_PREFERENCES = {
  timezone: "America/New_York",
  productEmails: true,
} as const

/**
 * REAL (identity) — `/v1/auth/me`, the one v1 route that already exists.
 * PLACEHOLDER (preferences) — `timezone` and `productEmails` come from
 * `user_preference`; swap in that endpoint and delete `PLACEHOLDER_PREFERENCES`.
 *
 * This is user-scoped, not org-scoped: ADR 0003 splits settings by resource
 * ownership, and a profile is owned by the person, not the team.
 */
export function useUserProfile() {
  const query = useQuery(getV1AuthMeOptions())
  const user = query.data?.user ?? null

  return {
    ...query,
    data:
      user === null
        ? undefined
        : ({
            name: user.name ?? user.email,
            email: user.email,
            ...PLACEHOLDER_PREFERENCES,
          } satisfies UserProfile),
  }
}
