import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * Programmatic API keys.
 *
 * A customer's own key for their own scripts — distinct from `agent_credential` (someone else's AI
 * provider) and from an OAuth client secret (a third party acting on a user's behalf). No consent
 * screen, no refresh: a long-lived secret pasted into CI.
 */

/**
 * The visible prefix.
 *
 * `sk_live_` so a key found in a log, a git history or a screenshot is identifiable at a glance —
 * a secret scanner, or a person, can tell what leaked without having to try it. There is no
 * `sk_test_`: SproutOS has one set of live resources and a "test" key that worked against them
 * would be a false reassurance.
 */
export const KEY_PREFIX = "sk_live_"

/** Characters of the key shown in a list. Enough to recognise, far too few to use. */
export const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8

export class InactiveGrantError extends Error {}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `${KEY_PREFIX}${Buffer.from(bytes).toString("base64url")}`
}

/**
 * Hashes a key for storage.
 *
 * Plain SHA-256, for the same reason the queue credentials and the OTLP ingest key are: this is 256
 * bits from the CSPRNG that nobody chose, so there is nothing for a work factor to make expensive,
 * and it is verified once per request — a hot path where Argon2's 19 MiB would be a
 * denial-of-service lever rather than a defence.
 */
export async function hashKey(key: string): Promise<string> {
  return `sha256$${encodeHexLowerCase(await sha256Utf8(key))}`
}

export function displayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH)
}

export type ResolvedKey = {
  id: string
  organizationId: string
  userId: string
  scopes: string[]
  oauthGrantId: string | null
}

/**
 * Resolves a presented key to who it acts as.
 *
 * The lookup is on the hash, which is unique and indexed, so a wrong key costs one index probe and
 * reveals nothing.
 *
 * Returns `undefined` for a key that does not exist, one that is revoked, one that has expired, and
 * one whose organization is gone. They are **one answer**, because distinguishing them tells an
 * anonymous caller which keys used to be real.
 */
export async function resolveKey(db: Kysely<DB>, key: string): Promise<ResolvedKey | undefined> {
  if (!key.startsWith(KEY_PREFIX)) return undefined

  const row = await db
    .selectFrom("apiKey")
    .innerJoin("organization", "organization.id", "apiKey.organizationId")
    .leftJoin("oauthGrant", "oauthGrant.id", "apiKey.oauthGrantId")
    .select([
      "apiKey.id as id",
      "apiKey.organizationId as organizationId",
      "apiKey.userId as userId",
      "apiKey.scopes as scopes",
      "apiKey.oauthGrantId as oauthGrantId",
      "oauthGrant.revokedAt as grantRevokedAt",
      "oauthGrant.organizationId as grantOrganizationId",
      "oauthGrant.userId as grantUserId",
    ])
    .where("apiKey.keyHash", "=", await hashKey(key))
    .where("apiKey.revokedAt", "is", null)

    .where((eb) =>
      eb.or([eb("apiKey.expiresAt", "is", null), eb("apiKey.expiresAt", ">", new Date())]),
    )
    .where("organization.deletedAt", "is", null)
    .executeTakeFirst()

  if (row === undefined) return undefined
  if (
    row.oauthGrantId !== null &&
    (row.grantRevokedAt !== null ||
      row.grantOrganizationId !== row.organizationId ||
      row.grantUserId !== row.userId)
  ) {
    return undefined
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    scopes: row.scopes ?? [],
    oauthGrantId: row.oauthGrantId,
  }
}

/**
 * Records that a key was used.
 *
 * Best effort and deliberately not awaited for correctness: it is the "last used" column on a
 * settings page, and refusing a request because a bookkeeping write failed would trade a real
 * capability for a cosmetic one.
 */
export async function stampUsed(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .updateTable("apiKey")
    .set({ lastUsedAt: new Date() })
    .where("id", "=", id)
    .execute()
    .catch(() => undefined)
}

export type IssueInput = {
  organizationId: string
  userId: string
  name: string
  scopes: string[]
  expiresAt?: Date | null
  oauthGrantId?: string | null
}

/** Mints a key. The plaintext is returned once and never stored. */
export async function issueKey(
  db: Kysely<DB>,
  input: IssueInput,
): Promise<{ id: string; key: string; prefix: string }> {
  const key = generateKey()
  const id = v7()
  const keyHash = await hashKey(key)

  await db.transaction().execute(async (tx) => {
    if (input.oauthGrantId !== undefined && input.oauthGrantId !== null) {
      const grant = await tx
        .selectFrom("oauthGrant")
        .select("id")
        .where("id", "=", input.oauthGrantId)
        .where("organizationId", "=", input.organizationId)
        .where("userId", "=", input.userId)
        .where("revokedAt", "is", null)
        .forShare()
        .executeTakeFirst()
      if (grant === undefined) throw new InactiveGrantError("The OAuth grant is no longer active")
    }

    await tx
      .insertInto("apiKey")
      .values({
        id,
        organizationId: input.organizationId,
        userId: input.userId,
        name: input.name,
        keyHash,
        prefix: displayPrefix(key),
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
        oauthGrantId: input.oauthGrantId ?? null,
      })
      .execute()
  })

  return { id, key, prefix: displayPrefix(key) }
}

/**
 * Revokes a key.
 *
 * A timestamp rather than a delete. The row is what answers "what did that key do" after the fact,
 * and `audit_log` entries reference it — deleting it would take the answer with it.
 */
export async function revokeKey(
  db: Kysely<DB>,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .updateTable("apiKey")
    .set({ revokedAt: new Date() })
    .where("id", "=", id)
    .where("organizationId", "=", organizationId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()

  return (result.numUpdatedRows ?? 0n) > 0n
}
