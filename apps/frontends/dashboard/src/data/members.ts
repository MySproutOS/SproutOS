import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugApiKeysByApiKeyIdMutation,
  deleteV1UserMeDeleteMutation,
  getV1UserMePreferencesQueryKey,
  getV1UserMeProfileOptions,
  getV1UserMeProfileQueryKey,
  patchV1UserMeProfileMutation,
  getV1OrgsByOrgSlugApiKeysOptions,
  getV1OrgsByOrgSlugApiKeysQueryKey,
  getV1OrgsByOrgSlugMembersOptions,
  postV1OrgsByOrgSlugApiKeysMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { baseUrl } from "@lib/api-client/index"
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
  `new Date(...)` here is now belt and braces rather than load-bearing.

  It used to be the only thing standing between this screen and `RangeError: Invalid time value`:
  the generated types said `createdAt: Date` and every date arrived as an ISO string, because
  `transformers.gen.ts` was emitted and never wired into the SDK. `transformer: true` in
  `.config/openapi-ts.config.ts` fixed that centrally, so the value really is a `Date`.

  Kept because `new Date(aDate)` is valid and costs nothing, and because this function also takes
  strings from callers that never went through the client.
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

/**
 * Downloads the caller's data as a file.
 *
 * Not a `useQuery`. The response is a document rather than state: caching it would keep a copy of
 * someone's personal data in memory long after they saved it, and re-fetching it on focus would be
 * a second download nobody asked for. It is a one-shot fetch that ends at a save dialog.
 *
 * `credentials: "include"` because the session is a cookie and this bypasses the generated client.
 */
export function useExportMyData() {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch(`${baseUrl}/v1/user/me/export`, { credentials: "include" })
      if (!response.ok) throw new Error(`The export could not be prepared (${response.status})`)

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `sproutos-export-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      // Without this the blob is held for the lifetime of the document, which for a single-page app
      // is until the tab closes — and the thing being held is the user's entire personal record.
      URL.revokeObjectURL(url)
    },
  })
}

/**
 * Closes the account.
 *
 * On success the session is already gone — the API cleared the cookie — so there is nothing to
 * invalidate and no authenticated view left to return to. A hard navigation to the marketing site
 * is the honest end: anything else leaves a shell rendering against a session that no longer exists.
 */
export function useCloseAccount() {
  return useMutation({
    ...deleteV1UserMeDeleteMutation(),
    onSuccess: () => {
      window.location.href = "/"
    },
  })
}
