import type { DB } from "@sproutos/db"
import { open } from "@lib/envelope"
import type { Kysely } from "kysely"

/**
 * The encryption context every `agent_credential.secret` is bound to.
 *
 * Exported and used by *both* sides, because seal and open must agree exactly — KMS
 * authenticates the context, so a one-word difference between the writer and the reader is a
 * credential that stores fine and never opens again. It lives here, next to the reader, so the
 * route that writes it has to import it rather than restate it.
 *
 * `credentialId` and `organizationId` are both in the context: without the id, a ciphertext moved
 * onto another row in the same organization would open; without the organization, one lifted into
 * another tenant's row would.
 */
export function credentialContext(
  organizationId: string,
  credentialId: string,
): Record<string, string> {
  return { field: "agent_credential.secret", credentialId, organizationId }
}

export type AgentCredentialKind =
  | "claude_subscription"
  | "anthropic_api_key"
  | "openai_api_key"
  | "openrouter_api_key"

/**
 * Who is paying for the tokens, which is the only question that changes how a run behaves.
 *
 * - `byo` — the customer's own subscription or API key. Costs us nothing, so the run needs no
 *   reservation and no metering. If they overspend, that is between them and their provider.
 * - `platform` — our key, charged to their credit balance. Every token is our money first, so the
 *   run is held against their balance before it starts and metered as it goes.
 * - `none` — no credential and credits not enabled. The run must not start.
 */
export type ResolvedAgentCredential =
  | {
      billing: "byo"
      credentialId: string
      kind: AgentCredentialKind
      secret: string
      baseUrl: string | null
      model: string | null
      permissionMode: string
      maxBudgetMicroUsd: bigint | null
    }
  | {
      billing: "platform"
      provider: "openai"
      model: string | null
      permissionMode: string
      maxBudgetMicroUsd: bigint | null
    }
  | { billing: "none"; reason: "no_credential" | "revoked" | "no_config" }

export class PlatformKeyMissingError extends Error {
  override readonly name = "PlatformKeyMissingError"

  constructor() {
    super("OPENAI_KEY is not set, so credit-billed agent runs cannot be served")
  }
}

/** Read lazily: dotenv has not run when this module is first evaluated. */
export function platformOpenAiKey(): string {
  const key = process.env.OPENAI_KEY
  if (key === undefined || key === "") throw new PlatformKeyMissingError()
  return key
}

/**
 * The agent config in force for a project: its own, or its organization's.
 *
 * Project scope wins outright rather than merging field by field. A half-inherited config — this
 * project's model with the organization's credential — is a combination nobody chose, and the one
 * that surprises people when the bill arrives.
 */
async function effectiveConfig(db: Kysely<DB>, organizationId: string, projectId: string | null) {
  if (projectId !== null) {
    const scoped = await db
      .selectFrom("agentConfig")
      .select([
        "agentCredentialId",
        "useSproutosCredits",
        "model",
        "permissionMode",
        "maxBudgetMicroUsd",
      ])
      .where("scope", "=", "project")
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    if (scoped !== undefined) return scoped
  }

  return await db
    .selectFrom("agentConfig")
    .select([
      "agentCredentialId",
      "useSproutosCredits",
      "model",
      "permissionMode",
      "maxBudgetMicroUsd",
    ])
    .where("scope", "=", "organization")
    .where("organizationId", "=", organizationId)
    .executeTakeFirst()
}

/**
 * Decide which key a run uses, and unseal it.
 *
 * The order matters and is not arbitrary. A named credential is preferred over platform credits
 * even when both are configured, because the credential is the thing the customer set up
 * deliberately and the one that costs them nothing extra. Credits are the fallback, and only when
 * `use_sproutos_credits` is explicitly true.
 *
 * That flag is why `agent_config.agent_credential_id` may be `ON DELETE SET NULL` without becoming
 * a trap: deleting your API key does not quietly move you onto a metered platform key, it leaves
 * you with `none` and a run that refuses to start.
 */
export async function resolveAgentCredential(
  db: Kysely<DB>,
  organizationId: string,
  projectId: string | null = null,
): Promise<ResolvedAgentCredential> {
  const config = await effectiveConfig(db, organizationId, projectId)
  if (config === undefined) return { billing: "none", reason: "no_config" }

  const shared = {
    model: config.model,
    permissionMode: config.permissionMode,
    maxBudgetMicroUsd: config.maxBudgetMicroUsd === null ? null : BigInt(config.maxBudgetMicroUsd),
  }

  if (config.agentCredentialId !== null) {
    const credential = await db
      .selectFrom("agentCredential")
      .select([
        "id",
        "kind",
        "baseUrl",
        "secretCiphertext",
        "secretWrappedDek",
        "secretKmsKeyId",
        "revokedAt",
        "deletedAt",
      ])
      .where("id", "=", config.agentCredentialId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()

    if (credential === undefined) return { billing: "none", reason: "no_credential" }
    if (credential.revokedAt !== null || credential.deletedAt !== null) {
      // Falling through to platform credits here would start charging the moment someone revokes
      // a key, which is the opposite of what revoking one means.
      return { billing: "none", reason: "revoked" }
    }

    const secret = await open(
      {
        ciphertext: credential.secretCiphertext,
        wrappedDek: credential.secretWrappedDek,
        kmsKeyId: credential.secretKmsKeyId,
      },
      credentialContext(organizationId, credential.id),
    )

    return {
      billing: "byo",
      credentialId: credential.id,
      kind: credential.kind as AgentCredentialKind,
      secret,
      baseUrl: credential.baseUrl,
      ...shared,
    }
  }

  if (config.useSproutosCredits) {
    return { billing: "platform", provider: "openai", ...shared }
  }

  return { billing: "none", reason: "no_credential" }
}
