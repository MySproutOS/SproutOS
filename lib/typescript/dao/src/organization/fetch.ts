import type { DB } from "@sproutos/db"
import { type Kysely, type Selectable, sql } from "kysely"

/**
 * Reads of `organization` filter `deleted_at IS NULL` by default, per ADR 0017. The table is
 * referenced by `usage_event` with `ON DELETE RESTRICT`, so rows are never actually removed and a
 * fetch that forgot the predicate would resurrect a deleted team in a UI.
 */
export function fetchOrganization(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["organization"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["organization"]>, T[number]> | undefined> {
    return await db
      .selectFrom("organization")
      .select(fields)
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function getBySlug<T extends (keyof DB["organization"])[]>(
    slug: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["organization"]>, T[number]> | undefined> {
    return await db
      .selectFrom("organization")
      .select(fields)
      .where("slug", "=", slug)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  /**
   * The organizations a user is an active member of.
   *
   * Membership, not ownership: a user who was invited into someone else's team must see it in the
   * switcher, and an owner is always a member of their own organization.
   */
  function listForUserQuery(userId: string) {
    return db
      .selectFrom("organization")
      .innerJoin("organizationMember", "organizationMember.organizationId", "organization.id")
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.status", "=", "active")
      .where("organization.deletedAt", "is", null)
      .select([
        "organization.id as id",
        "organization.slug as slug",
        "organization.name as name",
        "organization.kind as kind",
        "organization.ownerUserId as ownerUserId",
        "organization.createdAt as createdAt",
      ])
      .orderBy("organization.id", "desc")
  }

  async function listForUser(userId: string) {
    return await listForUserQuery(userId).execute()
  }

  /**
   * Where to send a user whose current organization just went away.
   *
   * Their personal organization wins, because it is the one that always exists and is the one
   * `ensureDefaultOrganization` created for them; after that, the oldest team they still belong
   * to. `null` means they belong to nothing, which is a real state for someone who left the only
   * team they were ever invited to.
   */
  async function getFallbackForUser(
    userId: string,
    excludeOrganizationId: string | null = null,
  ): Promise<{ id: string; slug: string } | null> {
    const row = await db
      .selectFrom("organization")
      .innerJoin("organizationMember", "organizationMember.organizationId", "organization.id")
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.status", "=", "active")
      .where("organization.deletedAt", "is", null)
      .$if(excludeOrganizationId !== null, (qb) =>
        qb.where("organization.id", "!=", excludeOrganizationId ?? ""),
      )
      .select(["organization.id as id", "organization.slug as slug"])
      .orderBy(sql`organization.kind = 'personal'`, "desc")
      .orderBy("organization.id", "asc")
      .executeTakeFirst()

    return row ?? null
  }

  async function countOwnedBy(userId: string): Promise<number> {
    const row = await db
      .selectFrom("organization")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("ownerUserId", "=", userId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return {
    countOwnedBy,
    getBySlug,
    getFallbackForUser,
    getOne,
    listForUser,
    listForUserQuery,
  }
}
