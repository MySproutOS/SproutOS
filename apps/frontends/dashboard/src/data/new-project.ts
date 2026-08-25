import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugGithubRepositoriesOptions,
  getV1OrgsByOrgSlugGithubRepositoryNameOptions,
  getV1OrgsByOrgSlugProjectsQueryKey,
  postV1OrgsByOrgSlugProjectsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * Is this repository name free?
 *
 * Debounced by the caller, not here: the query key is the name, so React Query would otherwise
 * fire a request per keystroke and race them. `enabled` is the other half — an empty box is not a
 * question worth asking GitHub.
 */
export function useRepositoryNameCheck(orgSlug: string, name: string, enabled: boolean) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubRepositoryNameOptions({ path: { orgSlug }, query: { name } }),
    enabled: enabled && name.length > 0,
    // The answer changes only when somebody creates a repository, and a stale "available" is
    // corrected by the create itself failing. Worth not re-asking on every focus.
    staleTime: 30_000,
    retry: false,
  })
}

/** The repositories the org's GitHub App installation can see, for "start from one I own". */
export function useGithubRepositories(orgSlug: string, enabled: boolean) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubRepositoriesOptions({ path: { orgSlug }, query: { perPage: 100 } }),
    enabled,
    retry: false,
  })
}

export function useCreateProject(orgSlug: string) {
  const queryClient = useQueryClient()

  return useMutation({
    ...postV1OrgsByOrgSlugProjectsMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}
