import { open, seal } from "./envelope"
import type { SealedValue } from "./types"

export function oauthIdentityFlowContext(flowId: string, userId: string) {
  return { flowId, userId, field: "oauth_identity_flow_pkce" }
}

export async function sealOauthIdentityVerifier(flowId: string, userId: string, verifier: string) {
  return await seal(verifier, oauthIdentityFlowContext(flowId, userId))
}

export async function openOauthIdentityVerifier(
  flowId: string,
  userId: string,
  value: SealedValue,
) {
  return await open(value, oauthIdentityFlowContext(flowId, userId))
}
