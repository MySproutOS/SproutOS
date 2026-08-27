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
