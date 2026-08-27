import { availableBalance } from "@lib/billing"
import { clearCreditState, publishCreditState } from "@lib/lambda"
import { Redis } from "ioredis"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
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
      if (await refreshOrganizationCreditState(db, client, organization.id)) exhausted += 1
    }

    console.info(
      `[billing] refreshed credit state for ${organizations.length} organization(s), ${exhausted} exhausted`,
    )
  }
}

/** Refresh one organization immediately after a balance-changing operation such as a top-up. */
export async function refreshOrganizationCreditState(
  db: Kysely<DB>,
  client: Redis,
  organizationId: string,
): Promise<boolean> {
  const balance = await availableBalance(db, organizationId)
  if (balance <= 0n) {
    await publishCreditState(client, organizationId, "exhausted")
    return true
  }

  // A top-up must actively remove an earlier refusal; waiting for the TTL would leave a paying
  // customer offline after Stripe has already confirmed their payment.
  await clearCreditState(client, organizationId)
  return false
}
