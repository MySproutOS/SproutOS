import { availableBalance } from "@lib/billing"
import { clearCreditState, publishCreditState } from "@lib/lambda"
import { Redis } from "ioredis"
import type { JobHandler } from "./worker"

/**
 * Refresh the router's short-lived view of whether an organization may spend.
 *
 * This deliberately implements credit exhaustion only. There is no product plan or per-dimension
 * quota model yet, so inventing one here would turn an unaudited threshold into an outage. A
 * positive spendable balance serves; zero or less is exhausted. The router still fails open when
 * this projection is absent or Valkey cannot be read.
 */
export const REFRESH_CREDIT_STATES_KIND = "billing.refresh_credit_states"

let shared: Redis | undefined
function valkey(): Redis {
  shared ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return shared
}

export function refreshCreditStates(options?: { valkey: Redis }): JobHandler {
  return async (_job, { db }) => {
    const client = options?.valkey ?? valkey()
    const organizations = await db
      .selectFrom("organization")
      .select("id")
      .where("deletedAt", "is", null)
      .execute()

    let exhausted = 0
    for (const organization of organizations) {
      // Keep writes bounded instead of bursting every organization at the cache simultaneously.
      // eslint-disable-next-line no-await-in-loop
      const balance = await availableBalance(db, organization.id)
      if (balance <= 0n) {
        // eslint-disable-next-line no-await-in-loop
        await publishCreditState(client, organization.id, "exhausted")
        exhausted += 1
      } else {
        // A top-up must actively remove an earlier refusal; waiting for the TTL would leave a
        // paying customer offline for up to fifteen minutes.
        // eslint-disable-next-line no-await-in-loop
        await clearCreditState(client, organization.id)
      }
    }

    console.info(
      `[billing] refreshed credit state for ${organizations.length} organization(s), ${exhausted} exhausted`,
    )
  }
}
