import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import {
  dockerComputeLauncher,
  neonComputeConfigFromEnv,
  wakeEndpoint,
  WakeTimeoutError,
} from "@lib/services"
import { validator } from "../utils/validator"

/**
 * Neon's storage controller, calling in.
 *
 * **This is a component the storage layer requires, not an integration on top of it.** The
 * controller decides which pageserver holds which tenant shard and notifies the control plane on
 * every attach. With no `--control-plane-url` it panics —
 * `called \`Option::unwrap()\` on a \`None\` value` in `compute_hook.rs` — *after* creating and
 * attaching the tenant, so the tenant exists and the reconcile never finishes. With a URL that
 * answers anything but 200 it retries forever with the same result.
 *
 * Self-hosting Neon therefore means implementing this endpoint before anything else works. None of
 * the `docker-compose` examples in circulation mention it, because they predate the storage
 * controller.
 *
 * The request shape was read off the controller's own log rather than its source — it prints the
 * struct it is about to send:
 *
 * ```
 * Sending notify request to http://…/notify-attach (NotifyAttachRequest {
 *   tenant_id: …, preferred_az: Some("local"), stripe_size: None,
 *   shards: [NotifyAttachRequestShard { node_id: NodeId(1), shard_number: ShardNumber(0) }] })
 * ```
 */

/**
 * `PUT`, and the path has no version.
 *
 * Both are the controller's choice: it appends `/notify-attach` to whatever `--control-plane-url`
 * it is given. Putting this under `/v1/internal` means the URL it is configured with ends
 * `/v1/internal/neon` — the version lives in the prefix, where this platform puts it, and the
 * controller never sees a path it did not construct.
 */
const notifyAttachRequest = Type.Object({
  tenant_id: Type.String({ pattern: "^[0-9a-f]{32}$" }),
  preferred_az: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  stripe_size: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  shards: Type.Array(Type.Object({ node_id: Type.Number(), shard_number: Type.Number() }), {
    minItems: 1,
  }),
})

const wakeRequest = Type.Object({
  /** The `backend_service` this connection is for. The proxy parses it out of the username. */
  backend_service_id: Type.String({ format: "uuid" }),
})

const wakeResponse = Type.Object({ host: Type.String(), port: Type.Integer() })

const neon: Hono = new Hono().put(
  "/neon/notify-attach",
  describeRoute({
    description:
      "Neon's storage controller reporting which pageserver now holds a tenant's shards. Called by the controller, not by users.",
    responses: {
      200: {
        description: "Placement recorded",
        content: { "application/json": { schema: resolver(Type.Object({})) } },
      },
      400: { description: "Not a notification this controller should be sending" },
    },
  }),
  validator("json", notifyAttachRequest),
  async (c) => {
    const body = c.req.valid("json")

    /*
      Replace the tenant's placement rather than upserting shard by shard.

      The notification carries *every* shard each time, so a shard absent from it is a shard that no
      longer exists — which is exactly what a shard merge looks like. Upserting alone would leave the
      old rows behind and point a compute at a pageserver that no longer holds anything.

      In one transaction, because a compute reading between the delete and the insert would find the
      tenant unplaced and conclude it had been detached.
    */
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("neonShardPlacement").where("tenantId", "=", body.tenant_id).execute()
      await trx
        .insertInto("neonShardPlacement")
        .values(
          body.shards.map((shard) => ({
            tenantId: body.tenant_id,
            shardNumber: shard.shard_number,
            nodeId: shard.node_id,
            preferredAz: body.preferred_az ?? null,
            stripeSize: body.stripe_size ?? null,
            updatedAt: new Date(),
          })),
        )
        .execute()
    })

    // The controller only checks the status. Anything but 200 and it retries this reconcile forever.
    return c.json({})
  },
)

/**
 * Wake the compute for a backend service, and say where it answers.
 *
 * **Called by `services/pg-proxy` on every connection**, which is why the warm path has to be one
 * indexed read — see `wakeEndpoint`. The proxy holds no Docker or Kubernetes credential; that is
 * the point of it being a data-plane component, and a proxy that could create workloads would be a
 * proxy whose compromise creates workloads. So it asks, and this answers.
 */
neon.post(
  "/neon/wake",
  describeRoute({
    description:
      "Start the compute for a backend service if it is suspended, and return where it answers. Called by pg-proxy, not by users.",
    responses: {
      200: {
        description: "Where the compute is listening",
        content: { "application/json": { schema: resolver(wakeResponse) } },
      },
      404: { description: "No Neon endpoint for that service" },
      503: { description: "The compute did not become ready in time" },
    },
  }),
  validator("json", wakeRequest),
  async (c) => {
    const { backend_service_id } = c.req.valid("json")

    const endpoint = await db
      .selectFrom("neonEndpoint")
      .select("id")
      .where("backendServiceId", "=", backend_service_id)
      // The primary branch's endpoint. A preview branch has its own row and its own connection.
      .orderBy("createdAt", "asc")
      .executeTakeFirst()

    if (endpoint === undefined) return c.json({ message: "No Neon endpoint" }, 404)

    try {
      const address = await wakeEndpoint(
        db,
        dockerComputeLauncher(neonComputeConfigFromEnv()),
        endpoint.id,
      )
      return c.json(address)
    } catch (cause) {
      /*
        503, not 500. A wake that timed out is a request worth retrying, and the proxy's client is
        a Postgres driver that will reconnect — telling it the platform is broken would make it stop.
      */
      if (cause instanceof WakeTimeoutError) {
        return c.json({ message: cause.message }, 503)
      }
      throw cause
    }
  },
)

export default neon
