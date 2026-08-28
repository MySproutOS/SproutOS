import type { DB } from "@sproutos/db"
import type { Kysely, Selectable, Updateable } from "kysely"
import { sql } from "kysely"

const PLATFORM_CERTIFICATE_ID = "platform"

export function crudPlatformEdgeCertificate(db: Kysely<DB>) {
  /** Create the singleton lazily so a scheduled job is enough to bootstrap certificate issuance. */
  async function ensure(): Promise<Selectable<DB["platformEdgeCertificate"]>> {
    await db
      .insertInto("platformEdgeCertificate")
      .values({ id: PLATFORM_CERTIFICATE_ID })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute()
    return await db
      .selectFrom("platformEdgeCertificate")
      .selectAll()
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .executeTakeFirstOrThrow()
  }

  /** Atomically claim the singleton without holding a connection during ACME network calls. */
  async function claimReconciliation(
    leaseToken: string,
    leaseSeconds = 600,
  ): Promise<Selectable<DB["platformEdgeCertificate"]> | undefined> {
    return await db
      .updateTable("platformEdgeCertificate")
      .set({
        reconcileLeaseToken: leaseToken,
        reconcileLeaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
        updatedAt: new Date(),
      })
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .where((eb) =>
        eb.or([
          eb("reconcileLeaseExpiresAt", "is", null),
          eb("reconcileLeaseExpiresAt", "<", sql<Date>`now()`),
        ]),
      )
      .returningAll()
      .executeTakeFirst()
  }

  async function heartbeatReconciliation(leaseToken: string, leaseSeconds = 600): Promise<boolean> {
    const result = await db
      .updateTable("platformEdgeCertificate")
      .set({
        reconcileLeaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
        updatedAt: new Date(),
      })
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .where("reconcileLeaseToken", "=", leaseToken)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async function releaseReconciliation(leaseToken: string): Promise<boolean> {
    const result = await db
      .updateTable("platformEdgeCertificate")
      .set({
        reconcileLeaseToken: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .where("reconcileLeaseToken", "=", leaseToken)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async function update(
    leaseToken: string,
    data: Updateable<DB["platformEdgeCertificate"]>,
  ): Promise<Selectable<DB["platformEdgeCertificate"]> | undefined> {
    return await db
      .updateTable("platformEdgeCertificate")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", PLATFORM_CERTIFICATE_ID)
      .where("reconcileLeaseToken", "=", leaseToken)
      .returningAll()
      .executeTakeFirst()
  }

  return { claimReconciliation, ensure, heartbeatReconciliation, releaseReconciliation, update }
}
