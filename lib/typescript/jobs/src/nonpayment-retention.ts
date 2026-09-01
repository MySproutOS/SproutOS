import { begin, decideReprieve, lockAvailableBalance, MINIMUM_TOPUP } from "@lib/billing"
import {
  crudCreditRetentionState,
  crudProjectJob,
  crudRetentionNoticeDelivery,
  fetchRetentionNoticeDelivery,
  initialSteps,
} from "@lib/dao"
import { emailTransport, renderRetentionNotice, type EmailTransport } from "@lib/email"
import { sql } from "kysely"
import { enqueue } from "./queue"
import {
  assertRetentionInventoryFresh,
  protectedRetentionReserve,
  refreshOrganizationCreditState,
} from "./credit-state"
import { tearDownProject, type TeardownClients } from "./teardown"
import { enqueueStaticAccessReconciliation } from "./static-suspension"
import type { JobHandler } from "./worker"
import { Redis } from "ioredis"

export const NONPAYMENT_RETENTION_KINDS = {
  scan: "billing.scan_nonpayment_retention",
  delete: "billing.delete_nonpayment_data",
  sendNotices: "billing.send_retention_notices",
} as const

/** Find due organizations. The generation makes every suspension window its own deletion claim. */
export const scanNonpaymentRetention: JobHandler = async (_job, { db }) => {
  const due = await db
    .selectFrom("creditRetentionState")
    .select(["organizationId", "generation"])
    .where("status", "=", "suspended")
    .where("deleteAfter", "<=", sql<Date>`now()`)
    .where("generation", "is not", null)
    .execute()

  for (const state of due) {
    await enqueue(db, {
      kind: NONPAYMENT_RETENTION_KINDS.delete,
      organizationId: state.organizationId,
      payload: { organizationId: state.organizationId, generation: state.generation },
      idempotencyKey: `${NONPAYMENT_RETENTION_KINDS.delete}:${state.organizationId}:${state.generation}`,
      maxAttempts: 100,
    })
  }
}

/**
 * Recheck money, attempt the configured auto-reload, then remove hosted provider data.
 * GitHub is deliberately absent: repository links are metadata, never deletion authority.
 */
export function deleteNonpaymentData(options?: {
  teardownClients?: TeardownClients
  valkey?: Redis
}): JobHandler {
  return async (job, context) => {
    const payload = job.payload as { organizationId?: unknown; generation?: unknown }
    if (typeof payload.organizationId !== "string" || typeof payload.generation !== "string") {
      throw new Error("Nonpayment deletion requires organizationId and generation")
    }
    const organizationId = payload.organizationId
    const generation = payload.generation
    const { db } = context
    const state = await db
      .selectFrom("creditRetentionState")
      .selectAll()
      .where("organizationId", "=", payload.organizationId)
      .executeTakeFirst()
    if (state === undefined || state.generation !== payload.generation) return
    if (state.status === "active" || state.status === "data_deleted") return
    if (state.deleteAfter === null || state.deleteAfter > new Date()) return

    let claimed: { deletionStartedAt: Date; deleteAfter: Date }
    if (state.status === "deleting") {
      // Cleanup can fail after one or more providers have already been removed. Once that
      // irreversible boundary is crossed, a retry must resume the same deletion claim rather than
      // offer a late reprieve or move either cutoff.
      if (state.deletionStartedAt === null) {
        throw new Error("Deleting retention state has no deletion cutoff")
      }
      claimed = { deletionStartedAt: state.deletionStartedAt, deleteAfter: state.deleteAfter }
    } else {
      // A final fresh inventory is a safety condition. Any provider/inventory failure throws and
      // the durable job retries without crossing into the destructive state.
      await assertRetentionInventoryFresh(db, payload.organizationId)
      const reserve = await protectedRetentionReserve(db, payload.organizationId)
      const customer = await db
        .selectFrom("stripeCustomer")
        .select([
          "stripeCustomerId",
          "defaultPaymentMethodId",
          "autoReloadEnabled",
          "autoReloadAmountMicroUsd",
        ])
        .where("organizationId", "=", payload.organizationId)
        .executeTakeFirst()
      const autoReloadAmount = BigInt(customer?.autoReloadAmountMicroUsd ?? MINIMUM_TOPUP)
      const decision = await decideReprieve(
        db,
        payload.organizationId,
        {
          enabled: customer?.autoReloadEnabled === true && customer.defaultPaymentMethodId !== null,
          ceilingMicroUsd: autoReloadAmount,
          chargedSoFarMicroUsd: 0n,
        },
        async () => {
          if (customer === undefined || customer.defaultPaymentMethodId === null) return false
          const existingAttempt = await db
            .selectFrom("topup")
            .select("status")
            .where("organizationId", "=", organizationId)
            .where("initiatedBy", "=", "auto_reload")
            .where("createdAt", ">=", state.exhaustedAt ?? new Date(0))
            .orderBy("createdAt", "desc")
            .executeTakeFirst()
          // Never create a second PaymentIntent while the first one's webhook is in flight. If it
          // already settled but still did not clear the newly measured reserve, the configured
          // reload amount was insufficient and the final attempt has genuinely failed.
          if (existingAttempt?.status === "pending" || existingAttempt?.status === "processing") {
            return true
          }
          if (existingAttempt?.status === "succeeded") return false
          try {
            await begin(db, {
              organizationId,
              amountMicroUsd: autoReloadAmount,
              initiatedBy: "auto_reload",
              stripeCustomerId: customer.stripeCustomerId,
              paymentMethodId: customer.defaultPaymentMethodId,
            })
            return true
          } catch (error) {
            console.error("[billing] final retention auto-reload failed", error)
            return false
          }
        },
        reserve,
      )

      if (decision.outcome === "deferred") {
        throw new Error("Auto-reload is awaiting its durable Stripe webhook credit")
      }
      if (decision.outcome === "reprieved") {
        await crudCreditRetentionState(db).update(payload.organizationId, {
          status: "active",
          warningStage: "safe",
          exhaustedAt: null,
          deleteAfter: null,
          deletionStartedAt: null,
          deletionCompletedAt: null,
        })
        const recipients = await fetchRetentionNoticeDelivery(db).billingRecipients(
          payload.organizationId,
        )
        for (const recipient of recipients) {
          await crudRetentionNoticeDelivery(db).createOnce({
            organizationId: payload.organizationId,
            generation: payload.generation,
            stage: "reprieved",
            userId: recipient.userId,
            recipient: recipient.email,
          })
        }
        await enqueueStaticAccessReconciliation(db, {
          organizationId: payload.organizationId,
          generation: payload.generation,
          suspended: false,
        })
        await refreshOrganizationCreditState(
          db,
          options?.valkey ?? new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023"),
          payload.organizationId,
        )
        return
      }

      const claim = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom("creditRetentionState")
          .select(["status", "generation", "deleteAfter"])
          .where("organizationId", "=", organizationId)
          .forUpdate()
          .executeTakeFirstOrThrow()
        if (locked.generation !== generation || locked.status === "active")
          return { outcome: "done" } as const
        const pendingTopup = await trx
          .selectFrom("topup")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("status", "in", ["pending", "processing"])
          .executeTakeFirst()
        if (pendingTopup !== undefined) return { outcome: "deferred" } as const
        const finalBalance = await lockAvailableBalance(trx, organizationId)
        if (finalBalance > reserve) {
          await trx
            .updateTable("creditRetentionState")
            .set({
              status: "active",
              warningStage: "safe",
              exhaustedAt: null,
              deleteAfter: null,
              deletionStartedAt: null,
              deletionCompletedAt: null,
              updatedAt: new Date(),
            })
            .where("organizationId", "=", organizationId)
            .execute()
          return { outcome: "reprieved" } as const
        }
        const claimRow = await trx
          .updateTable("creditRetentionState")
          .set({
            status: "deleting",
            warningStage: "deleting",
            reserveMicroUsd: reserve,
            reserveMeasuredAt: new Date(),
            deletionStartedAt: sql<Date>`coalesce(deletion_started_at, now())`,
            updatedAt: new Date(),
          })
          .where("organizationId", "=", organizationId)
          .returning(["deletionStartedAt", "deleteAfter"])
          .executeTakeFirstOrThrow()
        return { outcome: "claimed", ...claimRow } as const
      })
      if (claim.outcome === "deferred") throw new Error("A top-up is still being settled")
      if (claim.outcome === "done") return
      if (claim.outcome === "reprieved") {
        const recipients = await fetchRetentionNoticeDelivery(db).billingRecipients(organizationId)
        for (const recipient of recipients) {
          await crudRetentionNoticeDelivery(db).createOnce({
            organizationId,
            generation,
            stage: "reprieved",
            userId: recipient.userId,
            recipient: recipient.email,
          })
        }
        await enqueueStaticAccessReconciliation(db, {
          organizationId,
          generation,
          suspended: false,
        })
        await refreshOrganizationCreditState(
          db,
          options?.valkey ?? new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023"),
          organizationId,
        )
        return
      }
      if (claim.deletionStartedAt === null || claim.deleteAfter === null) {
        throw new Error("Deletion claim did not persist both cutoffs")
      }
      claimed = { deletionStartedAt: claim.deletionStartedAt, deleteAfter: claim.deleteAfter }
    }

    const projects = await db
      .selectFrom("project")
      .select("id")
      .where("organizationId", "=", payload.organizationId)
      .where("deletedAt", "is", null)
      .execute()
    const teardown = tearDownProject(options?.teardownClients)
    for (const project of projects) {
      const projectJob = await crudProjectJob(db).enqueueOnce({
        organizationId: payload.organizationId,
        projectId: project.id,
        repositoryId: null,
        kind: "delete",
        state: "queued",
        idempotencyKey: `nonpayment:${payload.generation}:${project.id}`,
        deletionReason: "nonpayment",
        serviceCutoffAt: claimed.deletionStartedAt,
        retentionCutoffAt: claimed.deleteAfter,
        steps: JSON.stringify(initialSteps("delete")),
      })
      const existing =
        projectJob ??
        (await db
          .selectFrom("projectJob")
          .select("id")
          .where("idempotencyKey", "=", `nonpayment:${payload.generation}:${project.id}`)
          .executeTakeFirstOrThrow())
      await teardown(
        {
          ...job,
          kind: "project.teardown",
          payload: {
            projectId: project.id,
            projectJobId: existing.id,
            deletionReason: "nonpayment",
            serviceCutoffAt: claimed.deletionStartedAt,
            retentionCutoffAt: claimed.deleteAfter,
          },
        },
        context,
      )
    }

    await crudCreditRetentionState(db).update(payload.organizationId, {
      status: "data_deleted",
      warningStage: "data_deleted",
      deletionCompletedAt: new Date(),
    })
    const recipients = await fetchRetentionNoticeDelivery(db).billingRecipients(
      payload.organizationId,
    )
    for (const recipient of recipients) {
      await crudRetentionNoticeDelivery(db).createOnce({
        organizationId: payload.organizationId,
        generation: payload.generation,
        stage: "data_deleted",
        userId: recipient.userId,
        recipient: recipient.email,
      })
    }
  }
}

export function sendRetentionNotices(transport?: EmailTransport): JobHandler {
  let resolved = transport
  return async (_job, { db }) => {
    const deliveries = await fetchRetentionNoticeDelivery(db).pending()
    for (const delivery of deliveries) {
      try {
        const message = await renderRetentionNotice({
          stage: delivery.stage as Parameters<typeof renderRetentionNotice>[0]["stage"],
          organizationName: delivery.organizationName,
          organizationSlug: delivery.organizationSlug,
          reserveMicroUsd: BigInt(delivery.reserveMicroUsd),
          deleteAfter: delivery.deleteAfter,
          dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? "http://localhost:3002",
        })
        await (resolved ??= emailTransport()).send({
          from: process.env.EMAIL_FROM ?? "SproutOS <notifications@sproutos.me>",
          to: delivery.recipient,
          ...message,
        })
        await crudRetentionNoticeDelivery(db).markSent(delivery.id)
      } catch (error) {
        await crudRetentionNoticeDelivery(db).markFailed(
          delivery.id,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}
