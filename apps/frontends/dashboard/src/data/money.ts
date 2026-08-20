/*
  ============================================================================
  PLACEHOLDER — delete this file.
  ============================================================================

  `@lib/billing` owns money formatting and exports `formatMicroUsd`. That package
  is not in this working tree yet (it arrived with PRs #8/#9; this branch is at
  #7 and `lib/typescript/billing/` currently holds only `node_modules/`), so this
  is a stand-in that produces the same figures the artboards show.

  When the merge lands:

    1. add `"@lib/billing": "workspace:*"` to this app's package.json
    2. replace every `from "@frontends/dashboard/data/money"` with `from "@lib/billing"`
    3. delete this file

  Nothing else changes: the amounts in `src/data/` are already `bigint` micro-USD,
  which is the shape the real endpoints return.
*/

const MICROS_PER_USD = 1_000_000n

/**
 * Sub-cent costs are the common case on a metered product — a job that costs
 * $0.0412 must not render as $0.04 — so this keeps up to four decimal places and
 * trims back to a minimum of two.
 */
export function formatMicroUsd(micros: bigint): string {
  const negative = micros < 0n
  const magnitude = negative ? -micros : micros

  const whole = magnitude / MICROS_PER_USD
  const fraction = magnitude % MICROS_PER_USD

  let digits = fraction.toString().padStart(6, "0").slice(0, 4)
  while (digits.length > 2 && digits.endsWith("0")) {
    digits = digits.slice(0, -1)
  }

  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${digits}`
}
