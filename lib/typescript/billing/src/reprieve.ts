import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { availableBalance } from "./ledger"
import type { MicroUsd } from "./money"

/**
 * The last check before a customer's data is destroyed.
 *
 * A tenant who runs out of credit stops being served, and forty-eight hours later their data is
 * deleted from every backend. That deletion is irreversible, so the question this answers is
 * narrow and important: **at the moment of deletion, is the customer still out of credit?**
 *
 * ## Why the decision cannot be made when the job is scheduled
 *
 * The obvious implementation reads the balance, finds it at zero, and enqueues a deletion for
 * forty-eight hours later. That job then runs and deletes. It is wrong, and the way it is wrong is
 * the worst kind: a customer who tops up at hour forty-seven — who has *paid*, who can see their
 * credit, whose dashboard says they are fine — loses everything anyway, because the decision was
 * taken two days earlier against a number that has since changed.
 *
 * So the balance is read again here, immediately before the destructive step, and auto-charge is
 * attempted first if the customer enabled it. A reprieve is the normal outcome for anyone who was
 * ever going to pay.
 *
 * ## Why auto-charge is attempted rather than assumed
 *
 * A customer with auto-charge enabled has told us to take money when they run low. Deleting their
 * data without trying is deleting the data of somebody who asked us not to let this happen. The
 * attempt can fail — an expired card, a declined payment — and then deletion proceeds, because at
 * that point the customer really has not paid and has had two days' notice.
 */

export type ReprieveDecision =
  | {
      outcome: "reprieved"
      reason: "balance_restored" | "auto_charge_succeeded"
      balance: MicroUsd
    }
  | { outcome: "deferred"; reason: "auto_charge_pending" }
  | { outcome: "delete"; reason: "still_unpaid" | "auto_charge_failed" | "auto_charge_disabled" }

/**
 * Attempt to charge a customer who has asked us to.
 *
 * Injected rather than imported so that the decision below is testable without Stripe: what this
 * module is responsible for is the *order* of the checks, and that is exactly what a test should be
 * able to exercise.
 */
export type AutoCharger = (organizationId: string) => Promise<boolean>

export type AutoChargeSettings = {
  enabled: boolean
  /** The ceiling the customer set on what we may charge beyond their balance. */
  ceilingMicroUsd: MicroUsd
  chargedSoFarMicroUsd: MicroUsd
}

/**
 * Decide whether to destroy a tenant's data, re-reading everything that could have changed.
 *
 * Returns rather than deletes. The caller does the destroying, and keeping the decision separate
 * from the destruction means the decision can be tested exhaustively and the destruction can be
 * audited against it.
 */
export async function decideReprieve(
  db: Kysely<DB>,
  organizationId: string,
  settings: AutoChargeSettings,
  autoCharge: AutoCharger,
  requiredReserve: MicroUsd = 0n,
): Promise<ReprieveDecision> {
  /*
    Read first, and read now.

    This is the whole point of the module. Anything decided when the grace period began is two days
    stale, and two days is long enough for a customer to notice an email, find a card, and pay.
  */
  const balance = await availableBalance(db, organizationId)

  if (balance > requiredReserve) {
    return { outcome: "reprieved", reason: "balance_restored", balance }
  }

  if (!settings.enabled) {
    return { outcome: "delete", reason: "auto_charge_disabled" }
  }

  /*
    The ceiling is the customer's own limit on what we may take, and it binds here as much as
    anywhere. Charging past it to save their data would be spending money they explicitly told us
    not to spend — a kindness that is also a violation, and one they would find on a statement.
  */
  if (settings.chargedSoFarMicroUsd >= settings.ceilingMicroUsd) {
    return { outcome: "delete", reason: "auto_charge_disabled" }
  }

  const charged = await autoCharge(organizationId)
  if (!charged) {
    return { outcome: "delete", reason: "auto_charge_failed" }
  }

  // Re-read rather than assuming the charge landed as credit. The charger reports success when the
  // payment succeeded; what matters here is whether the ledger now shows money.
  const afterCharge = await availableBalance(db, organizationId)
  if (afterCharge > requiredReserve) {
    return { outcome: "reprieved", reason: "auto_charge_succeeded", balance: afterCharge }
  }

  // Stripe confirms an off-session PaymentIntent before its webhook posts the corresponding
  // double-entry credit. Destruction must wait for that durable ledger write instead of racing it.
  return { outcome: "deferred", reason: "auto_charge_pending" }
}
