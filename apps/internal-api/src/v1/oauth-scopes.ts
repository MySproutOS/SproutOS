import { ACTIONS, isGrantableAction } from "../rbac"

export const OAUTH_IDENTITY_SCOPES = ["github:identity"] as const
export const OAUTH_SCOPES = [...ACTIONS, ...OAUTH_IDENTITY_SCOPES] as const

export function isOauthScope(value: string): boolean {
  return isGrantableAction(value) || OAUTH_IDENTITY_SCOPES.some((scope) => scope === value)
}

export function isIdentityScope(value: string): value is (typeof OAUTH_IDENTITY_SCOPES)[number] {
  return OAUTH_IDENTITY_SCOPES.some((scope) => scope === value)
}
