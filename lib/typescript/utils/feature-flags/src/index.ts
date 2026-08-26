/**
 * Capabilities the platform can build but is not yet ready to offer.
 *
 * Deliberately hard-coded constants rather than environment variables or a database table. A flag
 * that can be flipped without a commit is a flag whose state nobody can read from the code, and
 * every one of these guards something with a *reason* to be off that belongs next to it. Turning one
 * on should be a change somebody reviews.
 */

/**
 * Customer-supplied hostnames, served with their own certificate.
 *
 * **Off, and the reason is a hard AWS limit rather than anything unfinished.**
 *
 * The implementation works: a TXT record proves control of the zone, ACM issues a DNS-validated
 * certificate, and the certificate is attached to the ALB's HTTPS listener so SNI picks it for that
 * hostname. It was verified end to end against a real domain.
 *
 * It does not *scale*, and the ceiling is low. **An ALB listener carries 25 certificates**, raisable
 * by quota request but not indefinitely, and one certificate per customer domain means the platform
 * runs out at a number of customers that is not a business. There is no partial mitigation worth
 * having: batching several domains into one certificate caps at 100 names, ties unrelated tenants'
 * renewals together, and makes removing one domain a re-issue affecting all of them.
 *
 * The real answer is our own TLS termination — an edge tier holding certificates itself and
 * selecting on SNI, with the load balancer behind it passing bytes through. That is a service, not a
 * setting, and it is not built. Until it is, this stays off and the generated `*.sproutos.run`
 * hostname is what a customer gets.
 *
 * A wildcard would cover every *first-level* subdomain of one domain we own, which is what makes
 * `<project>-<discriminator>.sproutos.run` work on a single certificate. It cannot help here: a
 * certificate for `*.sproutos.run` says nothing about `example.com`, and no certificate we can
 * obtain covers a domain we do not control.
 */
/*
  **Temporarily on, to verify the path end to end against a real domain.**

  It goes back to `false` immediately afterwards. It is on at all because the alternative is
  shipping a disabled feature nobody has ever watched work — the certificate for the domain this was
  first tried against was created by hand with the AWS CLI, which proved that ACM issues
  certificates and proved nothing whatsoever about this code.
*/
export const CUSTOM_DOMAINS_ENABLED = true

/**
 * What to tell somebody who asks for one anyway.
 *
 * A sentence rather than a 404, because the feature is visibly half-present — the routes exist, the
 * table exists — and "not found" would read as a bug rather than a decision.
 */
export const CUSTOM_DOMAINS_DISABLED_REASON =
  "Custom domains are not available yet. Each one needs its own certificate attached to the load " +
  "balancer, which carries a hard limit of 25 — so this cannot be offered until SproutOS terminates " +
  "TLS itself at the edge. Your project is reachable on its sproutos.run hostname in the meantime."

/**
 * Whether the log extension is attached to customer functions.
 *
 * **Off, because the layer in the account crashes the application it is attached to.**
 *
 * The extension is a Lambda extension, and an extension process that exits takes the customer's
 * function down with it — `Extension.Crash`, on every invocation, with the cause in the extension's
 * log and nothing in the customer's. The layer published in production is a build old enough to
 * require `KAFKA_BROKERS`, which the platform stopped setting when logs moved to the router's token
 * endpoint. So the first customer application ever to reach an invocation was killed by the
 * observability component watching it.
 *
 * Two things have to be true before this goes back on, and only one of them is code:
 *
 * 1. `services/log-extension` no longer treats a missing sink as fatal — done, and the reasoning is
 *    beside the change.
 * 2. **The layer is rebuilt from that source and published**, which nothing in this repository does.
 *    `services/log-extension` is a crate; the layer in the account was published by hand, once, and
 *    its contents are a fact only AWS knows. That is the same shape as the certificate made by hand
 *    earlier in the week, and it is why the version running in production could drift this far from
 *    the source without anyone being able to see it.
 *
 * Turning this on before (2) restores the outage, because the flag governs attachment and not which
 * build gets attached.
 */
export const LOG_EXTENSION_ENABLED = false

export const LOG_EXTENSION_DISABLED_REASON =
  "The log extension layer in production predates the move to the router's log endpoint and exits " +
  "on startup, which crashes the customer function it is attached to. Re-enable once the layer is " +
  "rebuilt from services/log-extension and published."
