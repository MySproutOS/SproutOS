import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugProjectsByProjectIdDomainsByDomainIdMutation,
  getV1OrgsByOrgSlugDomainsOptions,
  getV1OrgsByOrgSlugDomainsQueryKey,
  postV1OrgsByOrgSlugProjectsByProjectIdDomainsByDomainIdCheckMutation,
  postV1OrgsByOrgSlugProjectsByProjectIdDomainsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import type { GetV1OrgsByOrgSlugDomainsResponse } from "@lib/api-client/generated/types.gen"
import type { Project } from "./projects"

export const CUSTOM_DOMAIN_POLL_INTERVAL_MS = 60_000

export const CUSTOM_DOMAIN_STATUS_LABELS = {
  pending_dns: "Waiting for DNS",
  issuing: "Issuing certificate",
  propagating: "Publishing certificate",
  active: "Active",
  renewal_warning: "Renewal warning",
  failed: "Needs attention",
  deleting: "Deleting",
} as const

export type CustomDomainStatus = keyof typeof CUSTOM_DOMAIN_STATUS_LABELS
export type CustomDomain = GetV1OrgsByOrgSlugDomainsResponse["data"][number]

export function eligibleCustomDomainProjects(projects: readonly Project[]): Project[] {
  return projects.filter(
    (project) =>
      !project.isGroup && project.servingMode === "serverless" && project.liveDeploymentId !== null,
  )
}

const NONTERMINAL_STATUSES = new Set<CustomDomainStatus>([
  "pending_dns",
  "issuing",
  "propagating",
  "renewal_warning",
  "deleting",
])

export function customDomainNeedsPolling(status: CustomDomainStatus): boolean {
  return NONTERMINAL_STATUSES.has(status)
}

/** Kept pure so the visibility and lifecycle rule can be covered without mounting React. */
export function shouldPollCustomDomains(
  domains: ReadonlyArray<Pick<CustomDomain, "status">> | undefined,
  visibilityState: DocumentVisibilityState,
): boolean {
  return (
    visibilityState === "visible" &&
    domains?.some((domain) => customDomainNeedsPolling(domain.status)) === true
  )
}

/**
 * Domains are reconciled asynchronously. Keep a visible, unfinished screen fresh without making
 * every open background tab poll forever; focus refetch covers the time the tab was hidden.
 */
export function useCustomDomains(orgSlug: string) {
  return useQuery({
    ...getV1OrgsByOrgSlugDomainsOptions({ path: { orgSlug } }),
    refetchInterval: (query) => {
      const visibility = typeof document === "undefined" ? "hidden" : document.visibilityState
      return shouldPollCustomDomains(query.state.data?.data, visibility)
        ? CUSTOM_DOMAIN_POLL_INTERVAL_MS
        : false
    },
    refetchIntervalInBackground: false,
  })
}

function useInvalidateCustomDomains(orgSlug: string) {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({
      queryKey: getV1OrgsByOrgSlugDomainsQueryKey({ path: { orgSlug } }),
    })
  }
}

export function useCreateCustomDomain(orgSlug: string) {
  const invalidate = useInvalidateCustomDomains(orgSlug)
  return useMutation({
    ...postV1OrgsByOrgSlugProjectsByProjectIdDomainsMutation(),
    onSuccess: invalidate,
  })
}

export function useCheckCustomDomain(orgSlug: string) {
  const invalidate = useInvalidateCustomDomains(orgSlug)
  return useMutation({
    ...postV1OrgsByOrgSlugProjectsByProjectIdDomainsByDomainIdCheckMutation(),
    onSuccess: invalidate,
  })
}

export function useDeleteCustomDomain(orgSlug: string) {
  const invalidate = useInvalidateCustomDomains(orgSlug)
  return useMutation({
    ...deleteV1OrgsByOrgSlugProjectsByProjectIdDomainsByDomainIdMutation(),
    onSuccess: invalidate,
  })
}
