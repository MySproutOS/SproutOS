import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

export type CreateOauthClient = {
  /** App-supplied UUIDv7, like every id in this schema. */
  id: string
  ownerUserId: string
  organizationId: string
  name: string
  homepageUrl: string
  clientType: string
  description?: string | null
  logoUrl?: string | null
  defaultScopes?: string[]
}

export type CreateOauthClientSecret = {
  oauthClientId: string
  /**
   * A hash, never the secret.
   *
   * The caller generates the secret, shows it to the developer once, and passes the hash here. This
   * function cannot return the secret because it never has it — which is the property that makes
   * "we cannot show it to you again" true rather than a policy.
   */
  secretHash: string
  /** The tail, so a developer can tell two secrets apart in a list. */
  lastFour: string
  expiresAt?: Date | null
}

export function crudOauthClient(db: Kysely<DB>) {
  /**
   * Create the client and its redirect URIs together.
   *
   * One transaction because a client with no redirect URI is not a usable client — the
   * authorization endpoint has nothing to match against and every request to it fails. Creating the
   * row first and the URIs after would leave that state reachable whenever the second call failed.
   */
  async function createClient(
    data: CreateOauthClient,
    redirectUris: readonly string[],
  ): Promise<{ id: string }> {
    return await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("oauthClient")
        .values({
          id: data.id,
          ownerUserId: data.ownerUserId,
          organizationId: data.organizationId,
          name: data.name,
          description: data.description ?? null,
          logoUrl: data.logoUrl ?? null,
          homepageUrl: data.homepageUrl,
          clientType: data.clientType,
          defaultScopes: data.defaultScopes ?? [],
        })
        .execute()

      if (redirectUris.length > 0) {
        await trx
          .insertInto("oauthClientRedirectUri")
          .values(redirectUris.map((uri) => ({ id: v7(), oauthClientId: data.id, uri })))
          .execute()
      }

      return { id: data.id }
    })
  }

  async function updateClient(
    organizationId: string,
    id: string,
    patch: {
      name?: string
      description?: string | null
      logoUrl?: string | null
      homepageUrl?: string
      defaultScopes?: string[]
    },
  ): Promise<boolean> {
    const result = await db
      .updateTable("oauthClient")
      .set({ ...patch, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()

    return (result.numUpdatedRows ?? 0n) > 0n
  }

  /**
   * Replace the whole set of redirect URIs rather than adding to it.
   *
   * A redirect URI is where the authorization code is delivered, so the set is a security boundary
   * and not a list of preferences. An "add" API leaves removal as a separate call somebody forgets,
   * and a URI nobody meant to keep is exactly the one an attacker registers a lookalike host for.
   * Replacing makes the stored set always equal to what the owner last confirmed.
   */
  async function replaceRedirectUris(
    organizationId: string,
    id: string,
    uris: readonly string[],
  ): Promise<boolean> {
    return await db.transaction().execute(async (trx) => {
      const owned = await trx
        .selectFrom("oauthClient")
        .select(["id"])
        .where("id", "=", id)
        .where("organizationId", "=", organizationId)
        .executeTakeFirst()

      if (owned === undefined) return false

      await trx.deleteFrom("oauthClientRedirectUri").where("oauthClientId", "=", id).execute()

      if (uris.length > 0) {
        await trx
          .insertInto("oauthClientRedirectUri")
          .values(uris.map((uri) => ({ id: v7(), oauthClientId: id, uri })))
          .execute()
      }

      await trx
        .updateTable("oauthClient")
        .set({ updatedAt: new Date() })
        .where("id", "=", id)
        .execute()

      return true
    })
  }

  async function addSecret(data: CreateOauthClientSecret): Promise<{ id: string }> {
    const id = v7()
    await db
      .insertInto("oauthClientSecret")
      .values({
        id,
        oauthClientId: data.oauthClientId,
        secretHash: data.secretHash,
        lastFour: data.lastFour,
        expiresAt: data.expiresAt ?? null,
      })
      .execute()
    return { id }
  }

  /**
   * Revoked, not deleted.
   *
   * A deleted secret leaves no trace that it ever authenticated anything, and "which credential
   * made this call last March" is the question an incident actually asks. `revoked_at` stops it
   * working and keeps the record.
   */
  async function revokeSecret(oauthClientId: string, secretId: string): Promise<boolean> {
    const result = await db
      .updateTable("oauthClientSecret")
      .set({ revokedAt: new Date() })
      .where("id", "=", secretId)
      .where("oauthClientId", "=", oauthClientId)
      .where("revokedAt", "is", null)
      .executeTakeFirst()

    return (result.numUpdatedRows ?? 0n) > 0n
  }

  /**
   * Suspend rather than delete, for the same reason the ledger is append-only.
   *
   * `oauth_grant` and every token issued reference this row. Deleting it would cascade away the
   * record of what users had authorized, which is the thing a user asking "what did I approve?"
   * needs. `status` stops the client working immediately.
   */
  async function setStatus(
    organizationId: string,
    id: string,
    status: "active" | "suspended",
  ): Promise<boolean> {
    const result = await db
      .updateTable("oauthClient")
      .set({ status, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()

    return (result.numUpdatedRows ?? 0n) > 0n
  }

  return { createClient, updateClient, replaceRedirectUris, addSecret, revokeSecret, setStatus }
}
