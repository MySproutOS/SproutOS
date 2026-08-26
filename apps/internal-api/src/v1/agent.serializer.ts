import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

const MicroUsdString = Type.String({ pattern: "^-?\\d+$" })

export const AGENT_CREDENTIAL_KINDS = [
  "claude_subscription",
  "anthropic_api_key",
  "openai_api_key",
  "openrouter_api_key",
] as const

export const PERMISSION_MODES = ["default", "plan", "accept_edits", "bypass_permissions"] as const

/**
 * Never contains the secret, in any shape.
 *
 * There is no reveal endpoint and no `secret` field to omit later — a credential you can read back
 * is one an exported database, a log line, or a screenshot hands to whoever has it. `lastFour` is
 * how a person tells two keys apart, and it is all they get.
 */
export const agentSchemaCredential = Type.Object({
  id: UUID7String,
  kind: Type.Union(AGENT_CREDENTIAL_KINDS.map((kind) => Type.Literal(kind))),
  label: Type.String(),
  lastFour: Nullable(Type.String()),
  baseUrl: Nullable(Type.String()),
  expiresAt: Nullable(Type.String({ format: "date-time" })),
  lastVerifiedAt: Nullable(Type.String({ format: "date-time" })),
  revokedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
})

export const agentSchemaCredentialListResponse = Type.Object({
  data: Type.Array(agentSchemaCredential),
})

export const agentSchemaCredentialCreateRequest = Type.Object({
  kind: Type.Union(AGENT_CREDENTIAL_KINDS.map((kind) => Type.Literal(kind))),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  secret: Type.String({ minLength: 8, maxLength: 8192 }),
  baseUrl: Type.Optional(Nullable(Type.String({ format: "uri", maxLength: 2048 }))),
  expiresAt: Type.Optional(Nullable(Type.String({ format: "date-time" }))),
})

export const agentSchemaCredentialIdParam = Type.Object({
  orgSlug: Type.String(),
  credentialId: UUID7String,
})

export const agentSchemaConfig = Type.Object({
  agentCredentialId: Nullable(UUID7String),
  useSproutosCredits: Type.Boolean(),
  model: Nullable(Type.String()),
  maxBudgetMicroUsd: Nullable(MicroUsdString),
  permissionMode: Type.Union(PERMISSION_MODES.map((mode) => Type.Literal(mode))),
  /** What a run would actually do right now, so the UI never has to re-derive the rules. */
  effectiveBilling: Type.Union([
    Type.Literal("byo"),
    Type.Literal("platform"),
    Type.Literal("none"),
  ]),
})

export const agentSchemaConfigUpdateRequest = Type.Object({
  agentCredentialId: Type.Optional(Nullable(UUID7String)),
  useSproutosCredits: Type.Optional(Type.Boolean()),
  model: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  maxBudgetMicroUsd: Type.Optional(Nullable(MicroUsdString)),
  permissionMode: Type.Optional(Type.Union(PERMISSION_MODES.map((mode) => Type.Literal(mode)))),
})

/** What a sandbox agent is given in place of a model provider's credential. */
export const agentSchemaProxyTokenRequest = Type.Object({
  /** The project the sandbox is working on, so usage is attributed to it. */
  projectId: Type.Optional(Nullable(UUID7String)),
})

export const agentSchemaProxyRefreshRequest = Type.Object({
  refreshToken: Type.String({ minLength: 1 }),
})

export const agentSchemaProxyTokenResponse = Type.Object({
  id: UUID7String,
  /** Returned once. Only a hash is stored, so this cannot be shown again. */
  accessToken: Type.String(),
  refreshToken: Type.String(),
  accessExpiresAt: Type.String({ format: "date-time" }),
  refreshExpiresAt: Type.String({ format: "date-time" }),
})
