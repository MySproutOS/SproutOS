import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugGithubOwnersOptions,
  getV1OrgsByOrgSlugGithubRepositoriesOptions,
  getV1OrgsByOrgSlugGithubRepositoryNameOptions,
  getV1OrgsByOrgSlugGithubUpstreamRepositoryOptions,
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
export function useRepositoryNameCheck(
  orgSlug: string,
  name: string,
  owner: string | null,
  enabled: boolean,
) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubRepositoryNameOptions({
      path: { orgSlug },
      // `owner` is part of the query key, so switching accounts re-asks rather than reusing the
      // previous account's verdict — the name is only free relative to somewhere.
      query: owner === null ? { name } : { name, owner },
    }),
    enabled: enabled && name.length > 0,
    // The answer changes only when somebody creates a repository, and a stale "available" is
    // corrected by the create itself failing. Worth not re-asking on every focus.
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * The GitHub accounts a repository could be created on.
 *
 * One entry per installation, so an empty list is the real answer to "where can this live" rather
 * than a failure — the dialog already has a sentence for that state and a link that fixes it.
 */
export function useGithubOwners(orgSlug: string, enabled: boolean) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubOwnersOptions({ path: { orgSlug } }),
    enabled,
    retry: false,
  })
}

/** The repositories the org's GitHub App installation can see, for "start from one I own". */
export function useGithubRepositories(orgSlug: string, enabled: boolean) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubRepositoriesOptions({ path: { orgSlug }, query: { perPage: 100 } }),
    enabled,
    refetchOnMount: "always",
    staleTime: 0,
    retry: false,
  })
}

export function useManualUpstreamCheck(
  orgSlug: string,
  fullName: string,
  githubRepoId: string | null,
  enabled: boolean,
) {
  return useQuery({
    ...getV1OrgsByOrgSlugGithubUpstreamRepositoryOptions({
      path: { orgSlug },
      query: { fullName, githubRepoId: githubRepoId ?? "0" },
    }),
    enabled: enabled && githubRepoId !== null,
    staleTime: 30_000,
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
