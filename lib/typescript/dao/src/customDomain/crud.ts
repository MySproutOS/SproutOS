import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { sql } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudCustomDomain(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["customDomain"]>, "id">,
  ): Promise<Selectable<DB["customDomain"]>> {
    return await db
      .insertInto("customDomain")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    organizationId: string,
    id: string,
    data: Updateable<DB["customDomain"]>,
  ): Promise<Selectable<DB["customDomain"]> | undefined> {
    return await db
      .updateTable("customDomain")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /** Claim reconciliation without holding a transaction or connection during ACME network work. */
  async function claimReconciliation(
    id: string,
    leaseToken: string,
    leaseSeconds = 300,
  ): Promise<Selectable<DB["customDomain"]> | undefined> {
    return await db
      .updateTable("customDomain")
      .set({
        reconcileLeaseToken: leaseToken,
        reconcileLeaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("reconcileLeaseExpiresAt", "is", null),
          eb("reconcileLeaseExpiresAt", "<", sql<Date>`now()`),
        ]),
      )
      .returningAll()
      .executeTakeFirst()
  }

  async function releaseReconciliation(id: string, leaseToken: string): Promise<boolean> {
    const result = await db
      .updateTable("customDomain")
      .set({
        reconcileLeaseToken: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("reconcileLeaseToken", "=", leaseToken)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async function heartbeatReconciliation(
    id: string,
    leaseToken: string,
    leaseSeconds = 300,
  ): Promise<boolean> {
    const result = await db
      .updateTable("customDomain")
      .set({
        reconcileLeaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("reconcileLeaseToken", "=", leaseToken)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  async function beginDelete(
    organizationId: string,
    id: string,
  ): Promise<Selectable<DB["customDomain"]> | undefined> {
    const now = new Date()
    return await db
      .updateTable("customDomain")
      .set({ status: "deleting", nextRetryAt: now, updatedAt: now })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  async function finishDelete(id: string, leaseToken: string): Promise<boolean> {
    const now = new Date()
    const result = await db
      .updateTable("customDomain")
      .set({
        deletedAt: now,
        nextRetryAt: null,
        reconcileLeaseToken: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where("id", "=", id)
      .where("status", "=", "deleting")
      .where("reconcileLeaseToken", "=", leaseToken)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) === 1
  }

  return {
    beginDelete,
    claimReconciliation,
    create,
    finishDelete,
    heartbeatReconciliation,
    releaseReconciliation,
    update,
  }
}
