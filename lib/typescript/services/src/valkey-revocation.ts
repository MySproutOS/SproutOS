import type { DB } from "@sproutos/db"
import { Redis } from "ioredis"
import { type Kysely, type Transaction, sql } from "kysely"
import { v7 } from "uuid"

export const VALKEY_ACL_REVOCATION_KIND = "platform.valkey_acl_deluser"

export type ValkeyAclRevocation = {
  generationId: string
  jobId: string
  username: string
}

export async function enqueueValkeyAclRevocation(
  trx: Transaction<DB>,
  input: { generationId: string; organizationId: string; username: string },
): Promise<ValkeyAclRevocation> {
  const jobId = v7()
  const payload = { generationId: input.generationId, username: input.username }
  const inserted = await trx
    .insertInto("backgroundJob")
    .values({
      id: jobId,
      idempotencyKey: `${VALKEY_ACL_REVOCATION_KIND}:${input.generationId}`,
      kind: VALKEY_ACL_REVOCATION_KIND,
      maxAttempts: 32767,
      organizationId: input.organizationId,
      payload: JSON.stringify(payload),
      priority: 100,
    })
    .onConflict((conflict) => conflict.column("idempotencyKey").doNothing())
    .returning("id")
    .executeTakeFirst()
  const actualJobId =
    inserted?.id ??
    (
      await trx
        .selectFrom("backgroundJob")
        .select("id")
        .where("idempotencyKey", "=", `${VALKEY_ACL_REVOCATION_KIND}:${input.generationId}`)
        .executeTakeFirstOrThrow()
    ).id
  return { ...payload, jobId: actualJobId }
}

export async function deleteValkeyAclUser(adminUrl: string, username: string): Promise<void> {
  const redis = new Redis(adminUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  redis.on("error", () => undefined)
  try {
    await redis.connect()
    await redis.call("ACL", "DELUSER", username)
  } finally {
    redis.disconnect()
  }
}

export async function lockValkeyAclUser(trx: Transaction<DB>, username: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${username}, 0))`.execute(trx)
}

export async function hasNewerValkeyCredential(
  trx: Transaction<DB>,
  revocation: Pick<ValkeyAclRevocation, "generationId" | "username">,
): Promise<boolean> {
  const newer = await trx
    .selectFrom("serviceCredential")
    .select("id")
    .where("username", "=", revocation.username)
    .where("id", ">", revocation.generationId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()
  return newer !== undefined
}

export async function runValkeyAclRevocation(
  db: Kysely<DB>,
  adminUrl: string,
  revocation: Pick<ValkeyAclRevocation, "generationId" | "username">,
): Promise<"deleted" | "superseded"> {
  return await db.transaction().execute(async (trx) => {
    await lockValkeyAclUser(trx, revocation.username)
    if (await hasNewerValkeyCredential(trx, revocation)) return "superseded"
    await deleteValkeyAclUser(adminUrl, revocation.username)
    return "deleted"
  })
}
