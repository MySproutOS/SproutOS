import { useQuery } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugBillingBalanceOptions,
  getV1OrgsByOrgSlugBillingStatementsOptions,
  getV1OrgsByOrgSlugBillingUsageOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type CreditBalance = {
  balanceMicros: bigint
  /** 0-100, drives the meter under the balance. */
  percentRemaining: number
  runwayLabel: string
}

export type UsageLine = {
  id: string
  label: string
  quantity: string
  costMicros: bigint
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
export function useCreditBalance(orgSlug: string) {
  const balance = useQuery(getV1OrgsByOrgSlugBillingBalanceOptions({ path: { orgSlug } }))
  const usage = useQuery(getV1OrgsByOrgSlugBillingUsageOptions({ path: { orgSlug } }))

  const available = balance.data === undefined ? 0n : BigInt(balance.data.availableMicroUsd)
  const burnPerDay = usage.data === undefined ? 0n : BigInt(usage.data.burnPerDayMicroUsd)

  const days = burnPerDay > 0n ? Number(available / burnPerDay) : null
  const percent = days === null ? 100 : Math.max(0, Math.min(100, Math.round((days / 30) * 100)))

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
            percentRemaining: percent,
            runwayLabel:
              days === null
                ? "No usage recorded yet"
                : `~${days} ${days === 1 ? "day" : "days"} at current burn`,
          } satisfies CreditBalance),
  }
}

/** What this organization has used so far this period, most expensive first. */
export function useUsageLines(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugBillingUsageOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.lines.map((line): UsageLine => ({
      id: line.dimension,
      label: line.label,
      // The unit belongs beside the number: "41.2" means nothing without "vCPU-hours".
      quantity: `${line.quantity} ${line.unit}`,
      costMicros: BigInt(line.amountMicroUsd),
    })),
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
