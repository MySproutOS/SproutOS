import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugOauthClientsByClientIdSecretsBySecretIdMutation,
  getV1OrgsByOrgSlugOauthClientsByClientIdSecretsOptions,
  getV1OrgsByOrgSlugOauthClientsByClientIdSecretsQueryKey,
  getV1OrgsByOrgSlugOauthClientsOptions,
  getV1OrgsByOrgSlugOauthClientsQueryKey,
  patchV1OrgsByOrgSlugOauthClientsByClientIdMutation,
  postV1OrgsByOrgSlugOauthClientsByClientIdSecretsMutation,
  postV1OrgsByOrgSlugOauthClientsMutation,
  putV1OrgsByOrgSlugOauthClientsByClientIdStatusMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"
import { relativeLabel } from "./projects"

/**
 * Applications registered against this platform's own OAuth provider.
 *
 * The interesting state here is not the list — it is the secret, which exists in a response exactly
 * once and is only a hash thereafter. Every hook below is shaped around that: creation returns the
 * value to show, and nothing re-reads it.
 */
export type OauthClient = {
  id: string
  name: string
  description: string | null
  homepageUrl: string
  logoUrl: string | null
  clientType: string
  isPublic: boolean
  isVerified: boolean
  status: string
  suspended: boolean
  defaultScopes: string[]
  redirectUris: string[]
  createdLabel: string
}

export type OauthClientSecret = {
  id: string
  lastFour: string
  createdLabel: string
  /** Null while live. A revoked secret keeps its row so "what happened" has an answer. */
  revokedLabel: string | null
  lastUsedLabel: string | null
  expiresLabel: string | null
}

export function useOauthClients(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugOauthClientsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.items.map((client): OauthClient => ({
      id: client.id,
      name: client.name,
      description: client.description,
      homepageUrl: client.homepageUrl,
      logoUrl: client.logoUrl,
      clientType: client.clientType,
      // A public client has no secret at all, which changes what the screen may offer rather than
      // only how it labels things.
      isPublic: client.clientType === "public",
      isVerified: client.isVerified,
      status: client.status,
      suspended: client.status !== "active",
      defaultScopes: client.defaultScopes,
      redirectUris: client.redirectUris,
      createdLabel: relativeLabel(client.createdAt),
    })),
  }
}

export function useOauthClientSecrets(orgSlug: string, clientId: string, enabled: boolean) {
  const query = useQuery({
    ...getV1OrgsByOrgSlugOauthClientsByClientIdSecretsOptions({ path: { orgSlug, clientId } }),
    enabled,
  })

  return {
    ...query,
    data: query.data?.items.map((secret): OauthClientSecret => ({
      id: secret.id,
      lastFour: secret.lastFour,
      createdLabel: relativeLabel(secret.createdAt),
      revokedLabel: secret.revokedAt === null ? null : relativeLabel(secret.revokedAt),
      lastUsedLabel: secret.lastUsedAt === null ? null : relativeLabel(secret.lastUsedAt),
      expiresLabel: secret.expiresAt === null ? null : relativeLabel(secret.expiresAt),
    })),
  }
}

export function useCreateOauthClient(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugOauthClientsMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthClientsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

export function useUpdateOauthClient(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...patchV1OrgsByOrgSlugOauthClientsByClientIdMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthClientsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

export function useSetOauthClientStatus(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...putV1OrgsByOrgSlugOauthClientsByClientIdStatusMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthClientsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

export function useIssueOauthClientSecret(orgSlug: string, clientId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugOauthClientsByClientIdSecretsMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthClientsByClientIdSecretsQueryKey({
          path: { orgSlug, clientId },
        }),
      })
    },
  })
}

export function useRevokeOauthClientSecret(orgSlug: string, clientId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...deleteV1OrgsByOrgSlugOauthClientsByClientIdSecretsBySecretIdMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugOauthClientsByClientIdSecretsQueryKey({
          path: { orgSlug, clientId },
        }),
      })
    },
  })
}
