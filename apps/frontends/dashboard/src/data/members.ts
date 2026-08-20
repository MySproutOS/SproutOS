import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugApiKeysByApiKeyIdMutation,
  getV1AuthMeOptions,
  getV1OrgsByOrgSlugApiKeysOptions,
  getV1OrgsByOrgSlugApiKeysQueryKey,
  getV1OrgsByOrgSlugMembersOptions,
  postV1OrgsByOrgSlugApiKeysMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { relativeLabel } from "@frontends/dashboard/data/projects"

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
  /** RBAC actions the key was granted. `["*"]` means "everything its creator can do". */
  scopes: string[]
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

/** The organization's live API keys. Revoked ones are not listed — see the route. */
export function useApiKeys(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugApiKeysOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((key): ApiKey => ({
      id: key.id,
      name: key.name,
      // The stored prefix plus an ellipsis: enough to tell two keys apart, far too little to use.
      prefix: `${key.prefix}\u2026`,
      createdLabel: relativeLabel(key.createdAt),
      // Null means never used, which the table renders differently from a date — a key nothing
      // has picked up is worth noticing.
      lastUsedLabel: key.lastUsedAt === null ? null : relativeLabel(key.lastUsedAt),
      scopes: key.scopes,
    })),
  }
}

/**
 * Mints a key.
 *
 * The secret comes back once and is deliberately **not** put in the query cache — caching it would
 * keep a live credential in memory for the rest of the session and, with devtools open, on screen.
 * The caller shows it and forgets it.
 */
export function useCreateApiKey(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugApiKeysMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugApiKeysQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

export function useRevokeApiKey(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...deleteV1OrgsByOrgSlugApiKeysByApiKeyIdMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugApiKeysQueryKey({ path: { orgSlug } }),
      })
    },
  })
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
