import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

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

/**
 * PLACEHOLDER — swap for `getV1OrganizationByOrgSlugCreditBalanceOptions(...)`.
 * The ledger is append-only and double-entry (AGENTS.md), so this reads a
 * projection, never a mutable balance column.
 */
export function useCreditBalance(orgSlug: string) {
  const balance: CreditBalance = {
    balanceMicros: 4_130_000n,
    percentRemaining: 41,
    runwayLabel: "~31 days at current burn",
  }
  return usePlaceholderQuery(["organizations", orgSlug, "credit-balance"], balance)
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugUsageOptions(...)`. */
export function useUsageLines(orgSlug: string) {
  const lines: UsageLine[] = [
    { id: "compute", label: "Compute", quantity: "41h 12m", costMicros: 1_940_000n },
    { id: "postgres", label: "Postgres storage", quantity: "2.4 GB", costMicros: 580_000n },
    { id: "queue", label: "Queue commands", quantity: "1,204,882", costMicros: 310_000n },
    { id: "search", label: "Search documents", quantity: "88,301", costMicros: 120_000n },
    { id: "egress", label: "Egress", quantity: "14.2 GB", costMicros: 70_000n },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "usage"], lines)
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugInvoiceOptions(...)`. */
export function useInvoices(orgSlug: string) {
  const invoices: Invoice[] = [
    { id: "in_01j8h2", period: "July 2026", status: "paid", totalMicros: 3_020_000n },
    { id: "in_01j7g4", period: "June 2026", status: "paid", totalMicros: 2_440_000n },
    { id: "in_01j6f9", period: "May 2026", status: "paid", totalMicros: 880_000n },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "invoices"], invoices)
}
