import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugApiKeysByApiKeyIdMutation,
  getV1UserMePreferencesQueryKey,
  getV1UserMeProfileOptions,
  getV1UserMeProfileQueryKey,
  patchV1UserMeProfileMutation,
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

/**
 * The caller's own profile.
 *
 * User-scoped, not organization-scoped: ADR 0003 splits settings by resource ownership, and a
 * profile belongs to the person rather than the team. There is no user id in the route — it acts on
 * whoever is calling — which is what makes it safe without a permission check.
 */
export function useUserProfile() {
  const query = useQuery(getV1UserMeProfileOptions())

  return {
    ...query,
    data:
      query.data === undefined
        ? undefined
        : ({
            name: query.data.name,
            email: query.data.email,
            timezone: query.data.timezone,
            productEmails: query.data.productEmails,
          } satisfies UserProfile),
  }
}

/**
 * Saves the profile.
 *
 * A PATCH of only what changed, so two fields edited on different visits do not overwrite each
 * other — and so a save on a form nobody touched is a no-op rather than a write.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    ...patchV1UserMeProfileMutation(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getV1UserMeProfileQueryKey() }),
        // The sidebar and the landing redirect read this one; a stale copy would show the old
        // preferences until the next full reload.
        queryClient.invalidateQueries({ queryKey: getV1UserMePreferencesQueryKey() }),
      ])
    },
  })
}
