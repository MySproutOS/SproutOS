import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudManagedCustomDomainPolicy(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["managedCustomDomainPolicy"]>, "id">,
  ): Promise<Selectable<DB["managedCustomDomainPolicy"]>> {
    return await db
      .insertInto("managedCustomDomainPolicy")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["managedCustomDomainPolicy"]>,
  ): Promise<Selectable<DB["managedCustomDomainPolicy"]> | undefined> {
    return await db
      .updateTable("managedCustomDomainPolicy")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  async function retire(id: string, actorUserId: string, deleted: boolean) {
    const policy = await db
      .selectFrom("managedCustomDomainPolicy")
      .selectAll()
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst()
    if (policy === undefined) return undefined

    const now = new Date()
    const domains = await db
      .updateTable("customDomain")
      .set({
        status: "deleting",
        nextRetryAt: now,
        reconcileLeaseToken: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where("managedDomainPolicyId", "=", id)
      .where("deletedAt", "is", null)
      .returning(["id", "organizationId"])
      .execute()

    const updated = await db
      .updateTable("managedCustomDomainPolicy")
      .set({
        status: "disabled",
        disabledAt: policy.disabledAt ?? now,
        disabledByUserId: policy.disabledByUserId ?? actorUserId,
        deletedAt: deleted ? now : null,
        deletedByUserId: deleted ? actorUserId : null,
        updatedAt: now,
        updatedByUserId: actorUserId,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { domains, policy: updated }
  }

  return { create, retire, update }
}
