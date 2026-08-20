import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchUserPreference(db: Kysely<DB>) {
  async function getForUser<T extends (keyof DB["userPreference"])[]>(
    userId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["userPreference"]>, T[number]> | undefined> {
    return await db
      .selectFrom("userPreference")
      .select(fields)
      .where("userId", "=", userId)
      .executeTakeFirst()
  }

  /**
   * The organization a request without an `orgSlug` in the path should resolve to.
   *
   * Joined against live membership rather than read straight off `user_preference`, because
   * `last_org_id` is `ON DELETE SET NULL` but nothing clears it when the user is merely *removed*
   * from the team. A stale pointer must resolve to nothing, not to an organization they left.
   */
  async function getLastOrganizationId(userId: string): Promise<string | null> {
    const row = await db
      .selectFrom("userPreference")
      .innerJoin("organization", "organization.id", "userPreference.lastOrgId")
      .innerJoin("organizationMember", "organizationMember.organizationId", "organization.id")
      .where("userPreference.userId", "=", userId)
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.status", "=", "active")
      .where("organization.deletedAt", "is", null)
      .select("organization.id as id")
      .executeTakeFirst()

    return row?.id ?? null
  }

  /** The same check as [[getLastOrganizationId]], but carrying the slug the URL needs. */
  async function getLastOrganization(userId: string): Promise<{ id: string; slug: string } | null> {
    const row = await db
      .selectFrom("userPreference")
      .innerJoin("organization", "organization.id", "userPreference.lastOrgId")
      .innerJoin("organizationMember", "organizationMember.organizationId", "organization.id")
      .where("userPreference.userId", "=", userId)
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.status", "=", "active")
      .where("organization.deletedAt", "is", null)
      .select(["organization.id as id", "organization.slug as slug"])
      .executeTakeFirst()

    return row ?? null
  }

  return { getForUser, getLastOrganization, getLastOrganizationId }
}
