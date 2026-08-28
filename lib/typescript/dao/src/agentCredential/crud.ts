import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export type CreateAgentCredential = {
  /**
   * Supplied by the caller, not generated here. The id is part of the encryption context the
   * secret was sealed under, so the row must carry the id that was sealed against — generating a
   * fresh one would store a ciphertext that can never be opened.
   */
  id: string
  organizationId: string
  kind: string
  label: string
  secretCiphertext: string
  secretWrappedDek: string
  secretKmsKeyId: string
  /**
   * The tail of the secret, so a person can tell two keys apart in a list. Everything else about
   * the secret is unreadable once it is stored, which is the point — there is no "show" action,
   * because a credential you can read back is a credential an exported database hands to whoever
   * has it.
   */
  lastFour: string | null
  baseUrl?: string | null
  expiresAt?: Date | null
}

export function crudAgentCredential(db: Kysely<DB>) {
  async function createCredential(
    data: CreateAgentCredential,
  ): Promise<Selectable<DB["agentCredential"]>> {
    return await db
      .insertInto("agentCredential")
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Revoke rather than delete.
   *
   * `agent_config.agent_credential_id` is `ON DELETE SET NULL`, and `usage_event` rows reference
   * runs that used this credential. A revoked row keeps the history readable and makes the
   * resolver return "revoked" — a run that refuses to start — instead of silently falling through
   * to whatever else is configured.
   */
  async function revokeCredential(organizationId: string, id: string): Promise<boolean> {
    const result = await db
      .updateTable("agentCredential")
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("revokedAt", "is", null)
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  async function updateLabel(
    organizationId: string,
    id: string,
    label: string,
  ): Promise<Selectable<DB["agentCredential"]> | undefined> {
    return await db
      .updateTable("agentCredential")
      .set({ label, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  async function softDeleteCredential(organizationId: string, id: string): Promise<boolean> {
    const result = await db
      .updateTable("agentCredential")
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  async function markVerified(id: string): Promise<void> {
    await db
      .updateTable("agentCredential")
      .set({ lastVerifiedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  return { createCredential, markVerified, revokeCredential, softDeleteCredential, updateLabel }
}
