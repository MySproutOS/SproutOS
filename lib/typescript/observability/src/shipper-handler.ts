import { readLiveDeployment } from "@lib/lambda"
import { Redis } from "ioredis"
import { ship, type ShipResult, type SubscriptionEvent } from "./shipper"

/**
 * The entry point AWS calls. Everything it does is in `ship`; this is the wiring.
 *
 * The Valkey client is module-scope on purpose, unlike everywhere else in this repository. A Lambda
 * execution environment is reused across invocations, so a connection opened here survives between
 * them — and opening one per invocation would mean a TCP and TLS handshake per batch of log lines.
 * The usual objection, that constructing clients at import time breaks a process that has no
 * environment, does not apply: this module is only ever loaded by Lambda, where it does.
 */
const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  // A shipper that cannot reach Valkey should file the batch under an unknown deployment and move
  // on, not spend its timeout retrying — the lines matter more than the attribution.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
})

export async function handler(event: SubscriptionEvent): Promise<ShipResult> {
  return await ship(event, async (projectId) => {
    try {
      return await readLiveDeployment(valkey, projectId)
    } catch {
      return undefined
    }
  })
}
