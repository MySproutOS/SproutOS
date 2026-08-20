/**
 * Money is `bigint` micro-USD everywhere. One millionth of a dollar, never a
 * float, never a decimal string that some caller will parse with `Number`.
 *
 * Unit *rates* are the exception and live in the database as `numeric(38,9)` —
 * a cache-read token costs 0.33 micro-USD and egress costs 0.00014, so a rate
 * held as an integer micro-USD would floor to zero and bill nothing at all.
 * Amounts are integers; rates are not.
 */
export type MicroUsd = bigint

export const MICRO_PER_USD = 1_000_000n
export const MICRO_PER_CENT = 10_000n

/** The smallest top-up the product accepts, per TASK 7. */
export const MINIMUM_TOPUP: MicroUsd = 500_000n

/**
 * Stripe's published card rate: 2.9% plus 30 cents.
 *
 * Hard-coded deliberately rather than read from Stripe, because it has to be
 * quoted to the user *before* the charge exists. If Stripe's rate changes this
 * is the one place to edit, and the reconciliation test in the statement path
 * is what will notice.
 */
const STRIPE_PERCENT_BPS = 290n
const STRIPE_FIXED: MicroUsd = 300_000n

/**
 * What we charge on top of Stripe's own cut. Zero: the processing fee is a
 * pass-through of Stripe's cost, not a margin.
 */
const MARKUP_BPS = 0n

/**
 * The processing fee for a charge of `amount`.
 *
 * TASK 7 fixes the minimum top-up at $0.50, and Stripe takes $0.3145 of that —
 * 63% — so a top-up that credited the full amount would lose money on every
 * small payment. The fee is shown as its own line so the arithmetic is visible
 * rather than hidden in a smaller credit than the user expected.
 *
 * Rounded up, because rounding a fee down means eating the remainder on every
 * single transaction.
 */
export function processingFee(amount: MicroUsd): MicroUsd {
  const percentage = ceilDiv(amount * (STRIPE_PERCENT_BPS + MARKUP_BPS), 10_000n)
  return percentage + STRIPE_FIXED
}

/** What actually lands in the user's balance after the processing fee. */
export function creditedAmount(amount: MicroUsd): MicroUsd {
  const credited = amount - processingFee(amount)
  return credited > 0n ? credited : 0n
}

/**
 * The platform's amortized overhead on metered usage, per TASK 28.
 *
 * Applied to the raw usage cost and posted as its own ledger entry rather than
 * folded into the usage figure, so a statement can show what the resources cost
 * and what the platform added, and the two add up to the total.
 */
export function overhead(usageCost: MicroUsd, overheadBps: number): MicroUsd {
  return ceilDiv(usageCost * BigInt(overheadBps), 10_000n)
}

/** Integer division that rounds away from zero, so fees never round in our favour by accident. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero")
  const negative = numerator < 0n !== denominator < 0n
  const a = numerator < 0n ? -numerator : numerator
  const b = denominator < 0n ? -denominator : denominator
  const q = a / b
  const r = a % b
  const rounded = r === 0n ? q : q + 1n
  return negative ? -rounded : rounded
}

/**
 * Convert a rate from `numeric(38,9)` and a quantity into whole micro-USD.
 *
 * The database hands back rates as decimal strings. Parsing them with `Number`
 * would lose precision on exactly the small rates that made `numeric` necessary,
 * so the string is scaled to an integer and multiplied in bigint throughout.
 */
export function rateTimesQuantity(rate: string, quantity: string): MicroUsd {
  return ceilDiv(decimalToScaled(rate) * decimalToScaled(quantity), SCALE * SCALE)
}

const DECIMALS = 9
const SCALE = 10n ** BigInt(DECIMALS)

function decimalToScaled(value: string): bigint {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = "0", fraction = ""] = unsigned.split(".")
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new RangeError(`Not a decimal number: ${value}`)
  }
  const padded = (fraction + "0".repeat(DECIMALS)).slice(0, DECIMALS)
  const scaled = BigInt(whole || "0") * SCALE + BigInt(padded || "0")
  return negative ? -scaled : scaled
}

/**
 * Render micro-USD as dollars and cents, rounding **down**.
 *
 * For a balance, not for a usage line. `formatMicroUsd` keeps every significant digit because a
 * metered line item genuinely costs a fraction of a cent and hiding that makes the column not add
 * up. A *balance* is different: `$11.292288` is not how anyone reads what they have left.
 *
 * Down, never nearest. Showing `$11.30` for a balance of 11.292288 tells a customer they can spend
 * a cent they do not have, and the failure lands at the moment they try.
 */
export function formatBalanceMicroUsd(amount: MicroUsd): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  // Truncating division on a bigint is already toward zero, which on the absolute value is down.
  const cents = abs / 10_000n
  const body = `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`
  return `${negative ? "-" : ""}$${body}`
}

/** Render micro-USD for display: `$1,204.00`, `$0.0412`. */
export function formatMicroUsd(amount: MicroUsd, minimumFractionDigits = 2): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const dollars = abs / MICRO_PER_USD
  const micros = abs % MICRO_PER_USD

  let fraction = micros.toString().padStart(6, "0").replace(/0+$/, "")
  while (fraction.length < minimumFractionDigits) fraction += "0"

  const whole = dollars.toLocaleString("en-US")
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole
  return `${negative ? "-" : ""}$${body}`
}
