import { MINIMUM_TOPUP } from "@lib/billing/money"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugBillingBalanceOptions,
  getV1OrgsByOrgSlugBillingStatementsOptions,
  getV1OrgsByOrgSlugBillingTopupQuoteOptions,
  getV1OrgsByOrgSlugBillingUsageOptions,
  postV1OrgsByOrgSlugBillingTopupMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type CreditBalance = {
  balanceMicros: bigint
  /** 0-100, drives the meter under the balance. */
  percentRemaining: number
  runwayLabel: string
}

export type UsageLine = {
  id: string
  category: string
  description: string | null
  label: string
  quantity: string
  costMicros: bigint
}

const CATEGORY_ORDER = ["Sandbox", "Postgres", "Cache", "AI", "Sites", "Workflows", "Search"]

/** Customer-facing service taxonomy. It does not imply that every category has every meter yet. */
export function usageCategory(dimension: string): string {
  if (dimension.startsWith("sandbox_")) return "Sandbox"
  if (dimension.startsWith("db_")) return "Postgres"
  if (dimension === "valkey_queue_byte_second") return "Cache"
  if (dimension.startsWith("ai_")) return "AI"
  if (dimension.startsWith("site_")) return "Sites"
  if (dimension.startsWith("workflow_")) return "Workflows"
  if (dimension.startsWith("es_")) return "Search"
  return "Other"
}

export function usageDescription(dimension: string): string | null {
  return dimension === "valkey_queue_byte_second"
    ? "Memory used by workflow queue data over time, measured as bytes multiplied by seconds."
    : null
}

export type Invoice = {
  id: string
  period: string
  status: "paid" | "open"
  totalMicros: bigint
}

const PERIOD_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

/**
 * The meter under the balance, and how long the credit lasts.
 *
 * **There is no "full".** A credit balance has no ceiling — a customer can top up any amount — so a
 * percentage needs a denominator that does not exist. The meter is scaled against 30 days of the
 * current burn instead: full means "a month of runway", which is a thing a person can act on, and
 * an empty meter means "top up now".
 *
 * With no burn there is nothing to run out of, so the meter is full and the label says so rather
 * than dividing by zero and claiming infinity days.
 */
/**
 * How much runway a balance buys at a burn rate, and what to call it.
 *
 * Pulled out of the hook so the three cases can be asserted. They are not symmetrical:
 *
 * - **Overdrawn** is the one a real customer reaches, and the one the original missed. It divided a
 *   negative balance by the burn and rendered `~-24 days at current burn`. Nobody has minus
 *   twenty-four days of runway; they have none, and they have already been billed for the
 *   difference. Checked before the division rather than clamped after it — `Math.max(0, …)` on the
 *   label would say "~0 days", which reads as "about to run out" rather than "already did".
 * - **No burn** has nothing to run out of, so the meter is full and the label says so rather than
 *   dividing by zero and claiming infinity days.
 * - **Burning** is the ordinary case: whole days, floored, because "3.7 days" is a precision
 *   nobody has.
 */
export function creditRunway(
  availableMicroUsd: bigint,
  burnPerDayMicroUsd: bigint,
): { percentRemaining: number; label: string } {
  if (availableMicroUsd <= 0n) {
    return { percentRemaining: 0, label: "Out of credit — top up to keep running" }
  }

  if (burnPerDayMicroUsd <= 0n) {
    return { percentRemaining: 100, label: "No usage recorded yet" }
  }

  const days = Number(availableMicroUsd / burnPerDayMicroUsd)

  return {
    // Full means a month of runway, which is a thing a person can act on.
    percentRemaining: Math.max(0, Math.min(100, Math.round((days / 30) * 100))),
    label: `~${days} ${days === 1 ? "day" : "days"} at current burn`,
  }
}

/**
 * Waits for a top-up to actually land, rather than assuming it has.
 *
 * The ledger moves from `payment_intent.succeeded` in `stripe-webhooks.ts`, not from the browser —
 * so when the payment dialog closes, the balance genuinely has not changed yet, and a single
 * refetch fired on close reads the old number and stops. That is what "I paid and it still says
 * $0.00" is: no bug in the ledger, no bug in the fetch, just a question asked a second too early.
 *
 * Nor can it be optimistically written: the credit added is the payment *minus Stripe's fee*, so
 * the only party that knows the real number is the webhook. Polling briefly is the honest way to
 * ask "has it arrived yet" — bounded, because a webhook that never comes must not spin forever.
 */
export function useAwaitTopup(orgSlug: string) {
  const queryClient = useQueryClient()

  return async function awaitTopup(): Promise<void> {
    const key = getV1OrgsByOrgSlugBillingBalanceOptions({ path: { orgSlug } }).queryKey
    const usageKey = getV1OrgsByOrgSlugBillingUsageOptions({ path: { orgSlug } }).queryKey

    const before = queryClient.getQueryData(key)?.availableMicroUsd

    for (const delay of TOPUP_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      await queryClient.invalidateQueries({ queryKey: key })

      const now = queryClient.getQueryData(key)?.availableMicroUsd

      // Moved, so the webhook landed. Usage feeds the runway line beside the balance, so it is
      // refreshed once here rather than on every poll.
      if (now !== undefined && now !== before) {
        await queryClient.invalidateQueries({ queryKey: usageKey })
        return
      }
    }
  }
}

/*
  Backing off rather than a fixed interval: the webhook usually lands in about a second, and the
  long tail is Stripe retrying. Six requests over ~15 seconds costs little and covers both.
*/
const TOPUP_POLL_DELAYS_MS = [700, 1_300, 2_000, 3_000, 4_000, 4_000]

export function useCreditBalance(orgSlug: string) {
  const balance = useQuery(getV1OrgsByOrgSlugBillingBalanceOptions({ path: { orgSlug } }))
  const usage = useQuery(getV1OrgsByOrgSlugBillingUsageOptions({ path: { orgSlug } }))

  const available = balance.data === undefined ? 0n : BigInt(balance.data.availableMicroUsd)
  const burnPerDay = usage.data === undefined ? 0n : BigInt(usage.data.burnPerDayMicroUsd)

  const runway = creditRunway(available, burnPerDay)

  return {
    isPending: balance.isPending || usage.isPending,
    isError: balance.isError || usage.isError,
    refetch: () => {
      void balance.refetch()
      void usage.refetch()
    },
    data:
      balance.data === undefined
        ? undefined
        : ({
            balanceMicros: available,
            percentRemaining: runway.percentRemaining,
            runwayLabel: runway.label,
          } satisfies CreditBalance),
  }
}

/** What this organization has used so far this period, most expensive first. */
export function useUsageLines(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugBillingUsageOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.lines
      .map((line): UsageLine => ({
        id: line.dimension,
        category: usageCategory(line.dimension),
        description: usageDescription(line.dimension),
        label: line.label,
        // The unit belongs beside the number: "41.2" means nothing without "vCPU-hours".
        quantity: `${line.quantity} ${line.unit}`,
        costMicros: BigInt(line.amountMicroUsd),
      }))
      .toSorted((a, b) => {
        const aCategory = CATEGORY_ORDER.indexOf(a.category)
        const bCategory = CATEGORY_ORDER.indexOf(b.category)
        const category =
          (aCategory === -1 ? CATEGORY_ORDER.length : aCategory) -
          (bCategory === -1 ? CATEGORY_ORDER.length : bCategory)
        if (category !== 0) return category
        return b.costMicros === a.costMicros ? 0 : b.costMicros > a.costMicros ? 1 : -1
      }),
  }
}

/**
 * Past statements.
 *
 * `status` is narrowed to the two words the table renders. A draft statement is "open" — the period
 * is still running and the figure will move — and a finalized one is "paid", which is what the
 * customer's card was charged for.
 */
export function useInvoices(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugBillingStatementsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((statement): Invoice => ({
      id: statement.id,
      period: PERIOD_FORMAT.format(new Date(statement.periodStart)),
      status: statement.status === "finalized" ? "paid" : "open",
      totalMicros: BigInt(statement.totalMicroUsd),
    })),
  }
}

/**
 * Start a top-up.
 *
 * Returns the Stripe client secret for a PaymentIntent the browser then confirms. The credit is
 * **not** applied here and must not be: `settle()` runs from the `payment_intent.succeeded`
 * webhook, so the ledger moves when Stripe says the money moved, not when a browser says it
 * submitted a form. A tab closed mid-confirmation still gets its credit; a request replayed against
 * this endpoint does not get it twice.
 */
export function useStartTopup(orgSlug: string) {
  return useMutation({
    ...postV1OrgsByOrgSlugBillingTopupMutation({ path: { orgSlug } }),
  })
}

/**
 * What a top-up actually costs and what it buys.
 *
 * Quoted by the server rather than computed here. The processing fee is a function the billing
 * library owns (`processingFee`), and a second implementation in the browser is a second answer —
 * the customer would be shown one number and charged another, and neither side would error.
 */
export function useTopupQuote(orgSlug: string, amountMicroUsd: bigint, enabled: boolean) {
  return useQuery({
    ...getV1OrgsByOrgSlugBillingTopupQuoteOptions({
      path: { orgSlug },
      query: { amountMicroUsd: amountMicroUsd.toString() },
    }),
    enabled: enabled && amountMicroUsd >= MINIMUM_TOPUP,
  })
}
