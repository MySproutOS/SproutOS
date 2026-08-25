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
 * Whether this deployment's Stripe account is in test mode.
 *
 * Read off the key's own prefix, which is the only thing that actually decides it — `pk_test_` and
 * `pk_live_` are different accounts, and the secret key on the server has to match or every intent
 * fails at confirmation.
 *
 * It is surfaced because the failure without it is genuinely confusing: a real card in test mode
 * comes back as **"Your card was declined"**, with the explanation buried in a sentence about test
 * mode that reads like boilerplate. Someone whose card works everywhere else is told their card
 * does not work, by a system that knew in advance it would refuse it.
 */
export const stripeTestMode = KEY.startsWith("pk_test_")

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
