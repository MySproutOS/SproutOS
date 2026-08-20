import { useQuery } from "@tanstack/react-query"
import { getV1AuthMeOptions } from "@lib/api-client/generated/@tanstack/react-query.gen"
import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"
import type { OrganizationRole } from "@frontends/dashboard/data/organizations"

export type Member = {
  id: string
  name: string
  email: string
  role: OrganizationRole
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

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugMemberOptions(...)`. */
export function useMembers(orgSlug: string) {
  const members: Member[] = [
    {
      id: "usr_01j8andrew",
      name: "Andrew Wang",
      email: "andrew@sproutos.dev",
      role: "owner",
      joinedLabel: "Feb 2026",
    },
    {
      id: "usr_01j8dana",
      name: "Dana Ortiz",
      email: "dana@acme.co",
      role: "admin",
      joinedLabel: "Apr 2026",
    },
    {
      id: "usr_01j8kai",
      name: "Kai Lindqvist",
      email: "kai@acme.co",
      role: "member",
      joinedLabel: "Jul 2026",
    },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "members"], members)
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
