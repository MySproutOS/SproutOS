import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * The ingest key a project's exporter presents.
 *
 * `sos_ing_` so a key found in a log file or a git history is identifiable at a glance — the point
 * of a prefix on a secret is that a scanner, or a person, can tell what was leaked without having
 * to try it.
 */
export const INGEST_KEY_PREFIX = "sos_ing_"

export type RetentionDays = 7 | 30 | 90

export function generateIngestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `${INGEST_KEY_PREFIX}${Buffer.from(bytes).toString("base64url")}`
}

/**
 * Hashes an ingest key for storage.
 *
 * Plain SHA-256, for the same reason the queue credentials are: this is 256 bits from the CSPRNG
 * that nobody chose, so there is nothing for a work factor to make expensive — and the ingest
 * endpoint verifies once per batch, which is a hot path where 19 MiB of Argon2 would be a
 * denial-of-service lever rather than a defence.
 */
export async function hashIngestKey(key: string): Promise<string> {
  return encodeHexLowerCase(await sha256Utf8(key))
}

export type Stream = {
  id: string
  projectId: string
  organizationId: string
  retentionDays: number
}

/**
 * Resolves an ingest key to the project it writes to.
 *
 * The lookup is on the **hash**, which is indexed and unique, so a wrong key costs one index probe
 * and reveals nothing. Returns `undefined` for a key that does not exist and for a key whose
 * project is deleted — the two are one answer, because distinguishing them tells an anonymous
 * caller which keys used to be real.
 */
export async function resolveIngestKey(db: Kysely<DB>, key: string): Promise<Stream | undefined> {
  if (!key.startsWith(INGEST_KEY_PREFIX)) return undefined

  const row = await db
    .selectFrom("observabilityStream")
    .innerJoin("project", "project.id", "observabilityStream.projectId")
    .select([
      "observabilityStream.id as id",
      "observabilityStream.projectId as projectId",
      "observabilityStream.retentionDays as retentionDays",
      "project.organizationId as organizationId",
    ])
    .where("observabilityStream.otlpIngestKeyHash", "=", await hashIngestKey(key))
    .where("project.deletedAt", "is", null)
    .executeTakeFirst()

  return row === undefined ? undefined : { ...row, retentionDays: Number(row.retentionDays) }
}

/**
 * Creates a project's stream, or replaces its key.
 *
 * Returns the plaintext key, which is the only time it exists outside the caller's response. There
 * is no "show me my key again": the hash is one-way, so rotating is the only way back, and a
 * rotation invalidates the old key — which is what makes it a recovery from a leak rather than a
 * convenience.
 */
export async function issueIngestKey(
  db: Kysely<DB>,
  projectId: string,
  retentionDays: RetentionDays = 7,
): Promise<{ key: string; streamId: string }> {
  const key = generateIngestKey()
  const hash = await hashIngestKey(key)

  const row = await db
    .insertInto("observabilityStream")
    .values({ id: v7(), projectId, otlpIngestKeyHash: hash, retentionDays })
    .onConflict((conflict) =>
      conflict
        .column("projectId")
        .doUpdateSet({ otlpIngestKeyHash: hash, retentionDays, updatedAt: new Date() }),
    )
    .returning("id")
    .executeTakeFirstOrThrow()

  return { key, streamId: row.id }
}
