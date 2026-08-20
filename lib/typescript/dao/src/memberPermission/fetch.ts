import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"

export type PermissionEffect = "allow" | "deny"

/** One `member_permission` row, which is one statement of one role the member holds. */
export type PermissionGrant = {
  effect: string
  actions: string[]
  resources: string[]
}

/**
 * The outcome of one authorization question.
 *
 * `denied` is not the negation of `allowed`: a member may hold a broad allow and a narrow deny
 * that both match, and deny wins. Both flags are read from the same query so the two can never be
 * computed against different snapshots.
 */
export type PermissionDecision = {
  allowed: boolean
  denied: boolean
}

export function fetchMemberPermission(db: Kysely<DB>) {
  /**
   * The hot path: one indexed query answering "may this member do this to this resource".
   *
   * `expandedActions` is the ancestor set of the requested action and `expandedResources` the
   * pattern set that covers the target SRN, so both sides reduce to array overlap against the GIN
   * index on `(actions, resources)`. `bool_or` collapses every matching row in the same query,
   * which is what makes deny-wins atomic rather than two round trips that could straddle a role
   * edit.
   */
  async function evaluate(
    userId: string,
    organizationId: string,
    expandedActions: readonly string[],
    expandedResources: readonly string[],
  ): Promise<PermissionDecision> {
    const row = await db
      .selectFrom("memberPermission")
      .where("userId", "=", userId)
      .where("organizationId", "=", organizationId)
      .where(sql<boolean>`actions && ${sql.val([...expandedActions])}::text[]`)
      .where(sql<boolean>`resources && ${sql.val([...expandedResources])}::text[]`)
      .select([
        sql<boolean | null>`bool_or(effect = 'allow')`.as("allowed"),
        sql<boolean | null>`bool_or(effect = 'deny')`.as("denied"),
      ])
      .executeTakeFirst()

    return { allowed: row?.allowed === true, denied: row?.denied === true }
  }

  /**
   * Every grant that overlaps any of the supplied actions and resources, in one indexed query.
   *
   * Callers that need "holds all of these" semantics evaluate the returned rows in application
   * code. They must not push that question into SQL as a single `actions @> ARRAY[...]`: Postgres
   * evaluates containment per row, so two permissions held through two different roles are two
   * rows and the containment test fails on both. Union semantics require aggregation across rows,
   * which is what this function hands back.
   */
  async function matchingGrants(
    userId: string,
    organizationId: string,
    actionUnion: readonly string[],
    resourceUnion: readonly string[],
  ): Promise<PermissionGrant[]> {
    return await db
      .selectFrom("memberPermission")
      .where("userId", "=", userId)
      .where("organizationId", "=", organizationId)
      .where(sql<boolean>`actions && ${sql.val([...actionUnion])}::text[]`)
      .where(sql<boolean>`resources && ${sql.val([...resourceUnion])}::text[]`)
      .select(["effect", "actions", "resources"])
      .execute()
  }

  /** Every grant a member holds in an organization. For a "what can I do here" screen. */
  async function listForMember(userId: string, organizationId: string): Promise<PermissionGrant[]> {
    return await db
      .selectFrom("memberPermission")
      .where("userId", "=", userId)
      .where("organizationId", "=", organizationId)
      .select(["effect", "actions", "resources"])
      .execute()
  }

  return { evaluate, listForMember, matchingGrants }
}
