import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/** `agent_credential.kind`. Auto-update defaults ON only for the first of these. */
export type AgentCredentialKind =
  | "claude_subscription"
  | "anthropic_api_key"
  | "openai_api_key"
  | "openrouter_api_key"

/**
 * Whether forked projects on this credential should update themselves without being asked.
 *
 * A Claude subscription token is flat-rate: upkeep runs cost the customer nothing beyond what
 * they already pay, so having it on by default is a favour. Every other kind is metered per
 * token, and an agent that wakes up nightly to reconcile a fork against upstream would spend real
 * money the customer never authorized. The default therefore keys on the *resolved* credential,
 * not on a product tier or a global setting.
 */
export function autoUpdateDefaultFor(kind: string | null | undefined): boolean {
  return kind === "claude_subscription"
}

export function fetchAgentCredential(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["agentCredential"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["agentCredential"]>, T[number]> | undefined> {
    return await db
      .selectFrom("agentCredential")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("revokedAt", "is", null)
      .executeTakeFirst()
  }

  /**
   * The credential a new project should adopt when the caller did not name one.
   *
   * A subscription is preferred over an API key when the organization holds both, because that is
   * the one whose marginal cost is already paid for.
   */
  async function getDefaultForOrganization<T extends (keyof DB["agentCredential"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["agentCredential"]>, T[number]> | undefined> {
    return await db
      .selectFrom("agentCredential")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("revokedAt", "is", null)
      .orderBy((eb) => eb.case().when("kind", "=", "claude_subscription").then(0).else(1).end())
      .orderBy("id", "asc")
      .executeTakeFirst()
  }

  return { getDefaultForOrganization, getInOrganization }
}
