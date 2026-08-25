import { loadStripe, type Stripe } from "@stripe/stripe-js"

/**
 * The publishable key, and why a missing one is not an exception.
 *
 * This key is public by design — it identifies the account to Stripe.js and can do nothing on its
 * own. What it cannot do is have a default: a key from another account produces a PaymentIntent
 * mismatch at confirmation time, which surfaces to the customer as a card error rather than as a
 * misconfiguration.
 *
 * So a missing key disables the top-up button with a reason on it, rather than throwing at module
 * load and taking the whole billing page down with it. A customer who cannot add credit should
 * still be able to read what they have spent.
 */
// Substituted at build time by `viteDefine`, which reads `STRIPE_PUBLIC_KEY` from the repo-root
// `.env`. Not `import.meta.env`: the name predates this dialog and is already carried to the
// servers through SSM, so a `VITE_`-prefixed twin would be a second name for one value.
const KEY: string = process.env.STRIPE_PUBLIC_KEY ?? ""

export const stripeConfigured = KEY !== ""

/**
 * Loaded once, lazily.
 *
 * `loadStripe` injects a script tag and Stripe asks that it be called once per page. Calling it at
 * module scope would also load Stripe.js for every visitor to every billing page, including the
 * ones only reading a statement.
 */
let pending: Promise<Stripe | null> | undefined

export function stripePromise(): Promise<Stripe | null> {
  if (!stripeConfigured) return Promise.resolve(null)
  pending ??= loadStripe(KEY)
  return pending
}
