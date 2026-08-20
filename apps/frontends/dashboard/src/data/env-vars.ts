import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugProjectsByProjectIdEnvByEnvVarIdMutation,
  getV1OrgsByOrgSlugProjectsByProjectIdEnvOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdEnvQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdEnvByEnvVarIdRevealMutation,
  putV1OrgsByOrgSlugProjectsByProjectIdEnvMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * The four environments a variable can belong to.
 *
 * `preview` is the *ephemeral* one — a deployment per open pull request — which is why it is not
 * called "staging". A long-lived staging tier would be a fifth value and a CHECK constraint
 * change; today, promoting a preview to production is a target edit on the row.
 */
export const ENV_TARGETS = ["production", "preview", "development", "all"] as const

export type EnvTarget = (typeof ENV_TARGETS)[number]

export const ENV_TARGET_LABELS: Record<EnvTarget, string> = {
  production: "Production",
  preview: "Preview",
  development: "Development",
  all: "All environments",
}

export const ENV_TARGET_HINTS: Record<EnvTarget, string> = {
  production: "The live deployment.",
  preview: "One deployment per open pull request.",
  development: "Local runs and dev sandboxes.",
  all: "Used by every environment that has no more specific value.",
}

export type EnvVar = {
  id: string
  key: string
  target: EnvTarget
  isSecret: boolean
  updatedLabel: string
}

const UPDATED_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
})

/*
  The generated types say `updatedAt: Date`, but this client has no `transformers.gen.ts` — every
  date arrives as an ISO string and the type is a lie. Coerce at the boundary, as `members.ts`
  does, or formatting throws `RangeError: Invalid time value`.
*/
function updatedLabel(value: Date | string): string {
  return UPDATED_FORMAT.format(new Date(value))
}

function isEnvTarget(value: string): value is EnvTarget {
  return (ENV_TARGETS as readonly string[]).includes(value)
}

export function useEnvVars(orgSlug: string, projectId: string) {
  const query = useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdEnvOptions({ path: { orgSlug, projectId } }),
  )

  return {
    ...query,
    data: query.data?.data.map((row): EnvVar => ({
      id: row.id,
      key: row.key,
      // The API types `target` as a bare string because the constraint lives in the database.
      // Anything unrecognized is shown under "all" rather than dropped: a variable that exists
      // but is invisible is worse than one filed in the wrong column.
      target: isEnvTarget(row.target) ? row.target : "all",
      isSecret: row.isSecret,
      updatedLabel: updatedLabel(row.updatedAt),
    })),
  }
}

/** Every mutation invalidates the same list, so the table always reflects what was stored. */
function useEnvVarInvalidation(orgSlug: string, projectId: string) {
  const client = useQueryClient()
  return () =>
    client.invalidateQueries({
      queryKey: getV1OrgsByOrgSlugProjectsByProjectIdEnvQueryKey({ path: { orgSlug, projectId } }),
    })
}

export function useSetEnvVar(orgSlug: string, projectId: string) {
  const invalidate = useEnvVarInvalidation(orgSlug, projectId)
  const mutation = useMutation(putV1OrgsByOrgSlugProjectsByProjectIdEnvMutation())

  return {
    ...mutation,
    setVar: async (input: { key: string; value: string; target: EnvTarget; isSecret: boolean }) => {
      await mutation.mutateAsync({ path: { orgSlug, projectId }, body: input })
      await invalidate()
    },
  }
}

export function useDeleteEnvVar(orgSlug: string, projectId: string) {
  const invalidate = useEnvVarInvalidation(orgSlug, projectId)
  const mutation = useMutation(deleteV1OrgsByOrgSlugProjectsByProjectIdEnvByEnvVarIdMutation())

  return {
    ...mutation,
    deleteVar: async (envVarId: string) => {
      await mutation.mutateAsync({ path: { orgSlug, projectId, envVarId } })
      await invalidate()
    },
  }
}

/**
 * Reveal is a POST, not a GET, and is deliberately not cached.
 *
 * Decrypting a value writes an `audit_log` row, so a cached read would make the audit trail claim
 * one look when there were five. It also means a revealed value lives only in the component that
 * asked for it — nothing puts it in the query cache where the next page would inherit it.
 */
export function useRevealEnvVar(orgSlug: string, projectId: string) {
  const mutation = useMutation(postV1OrgsByOrgSlugProjectsByProjectIdEnvByEnvVarIdRevealMutation())

  return {
    ...mutation,
    reveal: async (envVarId: string): Promise<string> => {
      const result = await mutation.mutateAsync({ path: { orgSlug, projectId, envVarId } })
      return result.value
    },
  }
}
