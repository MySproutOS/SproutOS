import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"

export function fetchRetentionNoticeDelivery(db: Kysely<DB>) {
  async function billingRecipients(organizationId: string) {
    return await db
      .selectFrom("organizationMember")
      .innerJoin("user", "user.id", "organizationMember.userId")
      .innerJoin("memberPermission", (join) =>
        join
          .onRef("memberPermission.organizationId", "=", "organizationMember.organizationId")
          .onRef("memberPermission.userId", "=", "organizationMember.userId"),
      )
      .select(["user.id as userId", "user.email"])
      .where("organizationMember.organizationId", "=", organizationId)
      .where("organizationMember.status", "=", "active")
      .where("user.deletedAt", "is", null)
      .where("memberPermission.effect", "=", "allow")
      .where(
        sql<boolean>`member_permission.actions && array['billing:write', 'billing:*', '*']::text[]`,
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("memberPermission as denied")
              .select(sql`1`.as("one"))
              .whereRef("denied.organizationId", "=", "organizationMember.organizationId")
              .whereRef("denied.userId", "=", "organizationMember.userId")
              .where("denied.effect", "=", "deny")
              .where(
                sql<boolean>`denied.actions && array['billing:write', 'billing:*', '*']::text[]`,
              ),
          ),
        ),
      )
      .distinct()
      .execute()
  }

  async function pending(limit = 50) {
    return await db
      .selectFrom("retentionNoticeDelivery")
      .innerJoin("organization", "organization.id", "retentionNoticeDelivery.organizationId")
      .innerJoin(
        "creditRetentionState",
        "creditRetentionState.organizationId",
        "retentionNoticeDelivery.organizationId",
      )
      .select([
        "retentionNoticeDelivery.id",
        "retentionNoticeDelivery.organizationId",
        "retentionNoticeDelivery.recipient",
        "retentionNoticeDelivery.stage",
        "retentionNoticeDelivery.attempts",
        "organization.name as organizationName",
        "organization.slug as organizationSlug",
        "creditRetentionState.reserveMicroUsd",
        "creditRetentionState.deleteAfter",
      ])
      .where("retentionNoticeDelivery.status", "in", ["pending", "failed"])
      .where("retentionNoticeDelivery.attempts", "<", 10)
      .orderBy("retentionNoticeDelivery.createdAt")
      .limit(limit)
      .execute()
  }

  return { billingRecipients, pending }
}
