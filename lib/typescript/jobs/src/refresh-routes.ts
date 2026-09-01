import { lambdaAliasArn, publishLiveDeployment, publishRoute, type Route } from "@lib/lambda"
import { Redis } from "ioredis"
import type { JobHandler } from "./worker"

/**
 * Re-publishing every live route, before the last write expires.
 *
 * `publishRoute` writes `route:<host>` with a 24-hour TTL and is called from exactly one place —
 * the release handler, at deploy time. Nothing refreshed it, and the router had no fallback: a miss
 * was a 404. So **every tenant site stopped resolving 24 hours after its last deploy**, and a
 * project nobody had redeployed in a day was simply gone.
 *
 * It passed every test that existed, because every test deploys and then immediately asserts. The
 * question worth asking of a check is not whether it passes but what would have to be true for it
 * to fail, and here the answer was "wait a day".
 *
 * This runs well inside the TTL so a single missed run is survivable. It is deliberately *not* the
 * only defence — the router now reads through to Postgres on a clean Valkey miss — because a
 * refresher that dies quietly must not reintroduce exactly the failure it was written to prevent.
 */
export const REFRESH_ROUTES_KIND = "platform.refresh_routes"

let shared: Redis | undefined
function valkey(): Redis {
  shared ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return shared
}

export function refreshRoutes(options?: {
  valkey: Redis
  region?: string
  accountId?: string
}): JobHandler {
  return async (_job, { db }) => {
    const client = options?.valkey ?? valkey()

    /*
      Driven from `project.live_deployment_id`, not from the deployment table.

      A project has many deployments and at most one that is serving; walking deployments would
      republish routes for releases that have been rolled back past, and the last writer would win
      arbitrarily. The live pointer is the only thing that says which release owns the hostname.
    */
    const live = await db
      .selectFrom("project")
      .innerJoin("deployment", "deployment.id", "project.liveDeploymentId")
      .select([
        "project.id as projectId",
        "project.organizationId as organizationId",
        "deployment.id as deploymentId",
        "deployment.hostname as hostname",
        "deployment.lambdaVersion as lambdaVersion",
      ])
      .where("project.deletedAt", "is", null)
      .where("deployment.deletedAt", "is", null)
      .where("deployment.hostname", "is not", null)
      .execute()

    const region = options?.region ?? process.env.AWS_REGION ?? "us-east-1"
    const accountId = options?.accountId ?? process.env.AWS_ACCOUNT_ID ?? ""

    let published = 0

    for (const row of live) {
      if (row.hostname === null) continue

      /*
        The alias ARN is reconstructed rather than stored.

        It is a pure function of the account, the region and the project id — `publishFunction`
        builds the same string — and storing it would be a second copy to go stale the day a
        deployment moves account or region. The alias always points at whichever version is live,
        which is what makes this correct after a rollback as well as after a deploy.
      */
      const route: Route = {
        arn: lambdaAliasArn({ region, accountId, projectId: row.projectId }),
        projectId: row.projectId,
        organizationId: row.organizationId,
        deploymentId: row.deploymentId,
      }

      // eslint-disable-next-line no-await-in-loop -- one small write each, and a Promise.all over
      // every tenant on the platform is a burst at the one cache the router depends on.
      await publishRoute(client, row.hostname, route)
      // eslint-disable-next-line no-await-in-loop
      await publishLiveDeployment(client, row.projectId, row.deploymentId)
      published += 1

      const domains = await db
        .selectFrom("customDomain")
        .select("hostname")
        .where("projectId", "=", row.projectId)
        .where("status", "=", "active")
        .where("deletedAt", "is", null)
        .execute()

      for (const domain of domains) {
        // eslint-disable-next-line no-await-in-loop
        await publishRoute(client, domain.hostname, route)
        published += 1
      }
    }

    console.log(`[routes] refreshed ${published} route(s) for ${live.length} live project(s)`)
  }
}
