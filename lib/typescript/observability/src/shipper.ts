import { gunzipSync } from "node:zlib"
import { projectIdFromLogGroup, toRows, writeRuntimeLogs, type RuntimeLog } from "./runtime-logs"

/**
 * The Lambda a CloudWatch Logs subscription filter invokes.
 *
 * One filter on the `/aws/lambda/sproutos-app-` prefix delivers every customer function's output
 * here, and this decodes it, turns it into rows, and writes them to ClickHouse.
 *
 * **What CloudWatch actually sends is not JSON.** The payload is `{"awslogs": {"data": "<base64 of
 * a gzip of the JSON>"}}` — three layers, none of them documented anywhere near the place you first
 * meet them, and a handler that tries `JSON.parse` on the body gets a syntax error that says
 * nothing about compression.
 */

/** The envelope on the invocation event. */
export type SubscriptionEvent = { awslogs: { data: string } }

/** What is inside, once decoded. */
export type DecodedPayload = {
  messageType: string
  logGroup: string
  logStream: string
  logEvents: { id: string; timestamp: number; message: string }[]
}

/**
 * Peel the three layers.
 *
 * Throws rather than returning undefined on malformed input: a payload that will not decode is not
 * a batch with no lines in it, and returning "nothing to do" would have the Lambda succeed and
 * CloudWatch never retry. Failing is what gets it redelivered.
 */
export function decode(event: SubscriptionEvent): DecodedPayload {
  const compressed = Buffer.from(event.awslogs.data, "base64")
  return JSON.parse(gunzipSync(compressed).toString("utf8")) as DecodedPayload
}

/**
 * How a project's live deployment is looked up.
 *
 * Injected so the handler can be tested without a Valkey, and because the lookup is the one part of
 * this that reaches out of the process.
 */
export type DeploymentLookup = (projectId: string) => Promise<string | undefined>

/** A deployment id for lines that arrived with no live deployment recorded. */
const UNKNOWN_DEPLOYMENT = "00000000-0000-0000-0000-000000000000"

export type ShipResult = {
  written: number
  skipped: number
  reason?: string
}

/**
 * Handle one delivery.
 *
 * `CONTROL_MESSAGE` is CloudWatch checking the destination is reachable when the filter is created.
 * It carries no log events, and a handler that treated it as data would write a row saying so.
 */
export async function ship(
  event: SubscriptionEvent,
  liveDeployment: DeploymentLookup,
  write: (rows: RuntimeLog[]) => Promise<void> = writeRuntimeLogs,
): Promise<ShipResult> {
  const payload = decode(event)

  if (payload.messageType === "CONTROL_MESSAGE") {
    return { written: 0, skipped: 0, reason: "control message" }
  }

  const projectId = projectIdFromLogGroup(payload.logGroup)
  if (projectId === undefined) {
    /*
      Not ours, or not a tenant application.

      Skipped rather than thrown: the filter is on a prefix, and a log group that matches the prefix
      without matching the naming is a configuration problem, not a delivery to retry. Throwing
      would have CloudWatch redeliver it forever.
    */
    return { written: 0, skipped: payload.logEvents.length, reason: "not a tenant log group" }
  }

  /*
    An unknown deployment does not lose the lines.

    The live deployment is a cache entry that expires, and a project whose logs arrive after it
    lapsed would otherwise have its output dropped — the moment a customer is most likely to be
    reading their logs is when something has just gone wrong. The rows land under the nil UUID and
    the viewer shows them; what is lost is the ability to filter that batch by deployment.
  */
  const deploymentId = (await liveDeployment(projectId)) ?? UNKNOWN_DEPLOYMENT

  const rows = toRows(payload.logGroup, deploymentId, payload.logEvents)
  await write(rows)

  return { written: rows.length, skipped: 0 }
}
