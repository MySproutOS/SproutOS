import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

export type AgentProxyTokenInsert = {
  id: string
  organizationId: string
  projectId: string | null
  agentCredentialId: string | null
  accessTokenHash: string
  refreshTokenHash: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
}

export function crudAgentProxyToken(db: Kysely<DB>) {
  async function create(input: AgentProxyTokenInsert): Promise<{ id: string }> {
    return await db
      .insertInto("agentProxyToken")
      .values(input)
      .returning("id")
      .executeTakeFirstOrThrow()
  }

  /**
   * Replace both halves of a token pair, in one statement.
   *
   * A refresh issues a new access token *and* a new refresh token. Leaving the old refresh token
   * valid would mean a leaked one stays useful for its whole window no matter how many times the
   * legitimate holder refreshes — which is the property refresh rotation exists to remove.
   */
  async function rotate(
    id: string,
    input: {
      accessTokenHash: string
      refreshTokenHash: string
      accessExpiresAt: Date
      refreshExpiresAt: Date
    },
  ): Promise<void> {
    await db
      .updateTable("agentProxyToken")
      .set({ ...input, updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  async function revoke(id: string): Promise<void> {
    await db
      .updateTable("agentProxyToken")
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("revokedAt", "is", null)
      .execute()
  }

  /** Withdraw every live token for a project — a sandbox torn down, a credential removed. */
  async function revokeForProject(projectId: string): Promise<void> {
    await db
      .updateTable("agentProxyToken")
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where("projectId", "=", projectId)
      .where("revokedAt", "is", null)
      .execute()
  }

  return { create, revoke, revokeForProject, rotate }
}
