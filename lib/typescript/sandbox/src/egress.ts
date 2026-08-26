/**
 * Daytona's provider-enforced outbound policy.
 *
 * Finding 0009 requires untrusted code to be unable to reach link-local/private infrastructure.
 * The original implementation generated `0.0.0.0/0` minus the blocked ranges, but the exact
 * complement has 73 CIDRs and Daytona accepts at most ten. It therefore rejected every create.
 *
 * Domain enforcement is the provider's non-bypassable alternative and permits twenty entries.
 * This intentionally favors isolation over arbitrary outbound access. Add a supported toolchain's
 * domain here; never replace this with `0.0.0.0/0`, which re-admits the metadata path.
 */
export const EGRESS_ALLOWED_DOMAINS = [
  "*.sproutos.me",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "*.npmjs.com",
  "*.neon.tech",
  "*.neon.build",
  "*.pypi.org",
  "*.pythonhosted.org",
  "crates.io",
  "*.rust-lang.org",
  "proxy.golang.org",
  "*.golang.org",
  "*.ubuntu.com",
  "*.debian.org",
  "*.docker.com",
  "docker.io",
  "*.cloudflare.com",
  "*.cloudflare.dev",
  "*.vercel.app",
] as const

export const EGRESS_DOMAIN_ALLOW_LIST = EGRESS_ALLOWED_DOMAINS.join(",")
