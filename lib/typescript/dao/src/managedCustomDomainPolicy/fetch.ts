import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchManagedCustomDomainPolicy(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["managedCustomDomainPolicy"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["managedCustomDomainPolicy"]>, T[number]> | undefined> {
    return await db
      .selectFrom("managedCustomDomainPolicy")
      .select(fields)
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function listActive<T extends (keyof DB["managedCustomDomainPolicy"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["managedCustomDomainPolicy"]>, T[number]>[]> {
    return await db
      .selectFrom("managedCustomDomainPolicy")
      .select(fields)
      .where("status", "=", "active")
      .where("deletedAt", "is", null)
      .orderBy("suffix", "desc")
      .execute()
  }

  async function listLive<T extends (keyof DB["managedCustomDomainPolicy"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["managedCustomDomainPolicy"]>, T[number]>[]> {
    return await db
      .selectFrom("managedCustomDomainPolicy")
      .select(fields)
      .where("deletedAt", "is", null)
      .orderBy("suffix", "desc")
      .execute()
  }

  async function listAll() {
    return await db
      .selectFrom("managedCustomDomainPolicy")
      .selectAll()
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "desc")
      .execute()
  }

  async function countAttached(id: string): Promise<number> {
    const row = await db
      .selectFrom("customDomain")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("managedDomainPolicyId", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  return { countAttached, getOne, listActive, listAll, listLive }
}
