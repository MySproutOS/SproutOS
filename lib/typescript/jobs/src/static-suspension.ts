/* oxlint-disable no-await-in-loop -- project locks and CloudFront KVS ETags must advance serially */
import { fetchCreditRetentionState } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { withProjectLock } from "./project-lock"
import { enqueue } from "./queue"
import {
  deactivateStaticHost,
  pointStaticSite,
  staticPlatformFromEnv,
  type StaticPlatform,
} from "./static-publish"
import type { JobHandler } from "./worker"

export const STATIC_ACCESS_RECONCILIATION_KIND = "billing.reconcile_static_access"

export async function enqueueStaticAccessReconciliation(
  db: Kysely<DB>,
  input: { organizationId: string; generation: string; suspended: boolean },
): Promise<void> {
  await enqueue(db, {
    kind: STATIC_ACCESS_RECONCILIATION_KIND,
    organizationId: input.organizationId,
    payload: input,
    idempotencyKey: `${STATIC_ACCESS_RECONCILIATION_KIND}:${input.organizationId}:${input.generation}:${input.suspended ? "suspended" : "active"}`,
    maxAttempts: 10,
  })
}

export function reconcileStaticAccess(options?: StaticPlatform): JobHandler {
  let platform = options
  return async (job, { db, keepAlive, signal }) => {
    const payload = job.payload as {
      organizationId?: unknown
      generation?: unknown
      suspended?: unknown
    }
    if (
      typeof payload.organizationId !== "string" ||
      typeof payload.generation !== "string" ||
      typeof payload.suspended !== "boolean"
    ) {
      throw new Error("Static access reconciliation requires organizationId, generation, and state")
    }
    const organizationId = payload.organizationId
    const generation = payload.generation
    const suspended = payload.suspended

    const stateStillMatches = async () => {
      const retention = await fetchCreditRetentionState(db).getOne(organizationId, [
        "generation",
        "status",
      ])
      if (retention === undefined || retention.generation !== generation) return false
      const currentlySuspended =
        retention.status === "suspended" ||
        retention.status === "deleting" ||
        retention.status === "data_deleted"
      return currentlySuspended === suspended
    }
    if (!(await stateStillMatches())) return

    const projects = await db
      .selectFrom("project")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .execute()

    const clients = (platform ??= staticPlatformFromEnv())
    for (const project of projects) {
      await withProjectLock(
        db,
        project.id,
        async () => {
          if (!(await stateStillMatches())) return
          const deployments = await db
            .selectFrom("deployment")
            .innerJoin("project", "project.id", "deployment.projectId")
            .select([
              "deployment.id",
              "deployment.kind",
              "deployment.hostname",
              "deployment.staticDigest",
              "project.liveDeploymentId",
            ])
            .where("project.id", "=", project.id)
            .where("project.deletedAt", "is", null)
            .where("deployment.deletedAt", "is", null)
            .where("deployment.status", "=", "ready")
            .where("deployment.preset", "=", "static")
            .execute()

          for (const deployment of deployments) {
            if (
              deployment.hostname === null ||
              deployment.staticDigest === null ||
              (deployment.kind !== "preview" && deployment.liveDeploymentId !== deployment.id)
            ) {
              continue
            }
            signal.throwIfAborted()
            if (!(await keepAlive())) {
              throw new Error("Lost ownership of static access reconciliation")
            }
            if (suspended) {
              await deactivateStaticHost(clients, {
                hostname: deployment.hostname,
                tenantZoneId: clients.tenantZoneId,
                keyValueStoreArn: clients.keyValueStoreArn,
                signal,
              })
            } else {
              await pointStaticSite(clients, {
                hostname: deployment.hostname,
                prefix: `${project.id}/${deployment.staticDigest}`,
                tenantZoneId: clients.tenantZoneId,
                distributionDomain: clients.distributionDomain,
                keyValueStoreArn: clients.keyValueStoreArn,
                signal,
              })
            }
          }
        },
        { keepAlive },
      )
    }
  }
}
