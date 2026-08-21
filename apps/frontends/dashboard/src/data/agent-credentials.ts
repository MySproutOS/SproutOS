import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugAgentCredentialsByCredentialIdMutation,
  getV1OrgsByOrgSlugAgentCredentialsOptions,
  getV1OrgsByOrgSlugAgentCredentialsQueryKey,
  postV1OrgsByOrgSlugAgentCredentialsMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

/**
 * The model credentials the agent runs on.
 *
 * `POST /v1/orgs/:orgSlug/agent/credentials` has existed since the agent routes were written, and
 * Settings had four tabs — Profile, Billing, Members, API keys — and no way to reach it. So the
 * headline feature of the product ("say in a sentence what you want changed") answered
 * `No model credential configured` and offered nowhere to configure one.
 */

/** `agent_credential.kind`. The labels are what a customer calls these, not what the column does. */
export const CREDENTIAL_KINDS = [
  {
    kind: "claude_subscription",
    label: "Claude subscription",
    /*
      Flat-rate, which is why this is the one kind that turns fork auto-update on by default —
      see `autoUpdateDefaultFor`. Worth saying on the form, because the consequence lands later,
      on a different screen, as nightly runs the customer did not ask for.
    */
    hint: "Flat-rate. Fork auto-update defaults to on for projects using this.",
  },
  { kind: "anthropic_api_key", label: "Anthropic API key", hint: "Metered per token." },
  { kind: "openai_api_key", label: "OpenAI API key", hint: "Metered per token." },
  { kind: "openrouter_api_key", label: "OpenRouter API key", hint: "Metered per token." },
] as const

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]["kind"]

export type AgentCredential = {
  id: string
  kind: string
  kindLabel: string
  label: string
  /** The last four characters. The secret itself is never returned — it is sealed under KMS. */
  lastFour: string | null
  /*
    `Date`, not `string`. `transformer: true` in the openapi-ts config revives every
    `format: date-time` field, so the generated types hand back real Dates — the same trap that
    made `members.ts` carry a defensive `new Date(...)`.
  */
  revokedAt: Date | null
  lastVerifiedAt: Date | null
}

const KIND_LABELS = new Map(CREDENTIAL_KINDS.map((entry) => [entry.kind as string, entry.label]))

export function useAgentCredentials(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugAgentCredentialsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((row): AgentCredential => ({
      id: row.id,
      kind: row.kind,
      // Falls back to the raw column rather than blank: a kind this build does not know about is
      // still a credential somebody is relying on, and hiding its name helps nobody.
      kindLabel: KIND_LABELS.get(row.kind) ?? row.kind,
      label: row.label,
      lastFour: row.lastFour,
      revokedAt: row.revokedAt,
      lastVerifiedAt: row.lastVerifiedAt,
    })),
  }
}

export function useCreateAgentCredential(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugAgentCredentialsMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugAgentCredentialsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

export function useRevokeAgentCredential(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    ...deleteV1OrgsByOrgSlugAgentCredentialsByCredentialIdMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugAgentCredentialsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}
