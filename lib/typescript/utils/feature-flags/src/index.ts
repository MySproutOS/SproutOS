/**
 * Custom domains stay closed until the Rust certificate inventory, NLB TCP listeners, and
 * production certificate smoke test have all completed. The old ACM/ALB implementation is gone;
 * this flag is now the final rollout gate, not a workaround for the ALB certificate quota.
 */
export const CUSTOM_DOMAINS_ENABLED = false

export const CUSTOM_DOMAINS_DISABLED_REASON =
  "Custom domains are being moved to the SproutOS Rust TLS edge. Creation will open after the " +
  "certificate inventory and production ingress have passed their rollout checks."
