/**
 * Turning the manifests in `deploy/` into something applicable.
 *
 * They are written with literal placeholders — `ACCOUNT`, `REGION`, `TAG`, `KMS_KEY_ARN` — because a
 * manifest that hard-codes an account id is a manifest that only works in one account, and one that
 * carries a templating language needs a templating engine to read.
 *
 * The substitution itself is three lines. Everything else here exists because of the failure mode:
 * **an unsubstituted placeholder is valid YAML.** `image: IMAGE_REGISTRY/internal-api:TAG`
 * passes every schema check, applies cleanly, and fails at image pull — by which point it is a
 * production incident rather than a build error.
 *
 * So rendering refuses to produce output with a placeholder left in it.
 */

/**
 * The placeholders these manifests use.
 *
 * An explicit list rather than a pattern like `/[A-Z_]{4,}/`. A pattern would match `FATAL`,
 * `NoSchedule`, `RuntimeDefault` and half the words in a Kubernetes manifest, and the resulting
 * false positives would train whoever hit them to pass `--force`.
 */
export const PLACEHOLDERS = [
  "ACCOUNT",
  "REGION",
  "IMAGE_REGISTRY",
  "TAG",
  "TENANT_NAMESPACE",
  "KMS_KEY_ARN",
  "CONTROL_PLANE_DB_SECRET_ARN",
  "TENANT_POSTGRES_HOST",
  "TENANT_VALKEY_HOST",
  "TENANT_OPENSEARCH_HOST",
  "BUILD_REGISTRY_CIDR",
  /*
    The public hostnames, and the cookie scope that follows from them.

    `CONTROL_PLANE_HOST` and `API_HOST` are separate values rather than one apex with prefixes
    appended, because nothing guarantees the two share a parent — a deployment may put the API on a
    different registrable domain entirely, and a renderer that assumes otherwise silently produces
    a CORS allowlist that excludes the site's own browser.

    `SESSION_COOKIE_DOMAIN` is a third value for the same reason, spelled out in `@utils/cookies`:
    it cannot be derived from either host without the Public Suffix List, and deriving it wrongly
    produces an app that looks signed out rather than an error.
  */
  "CONTROL_PLANE_HOST",
  "API_HOST",
  "SESSION_COOKIE_DOMAIN",
  // The suffix Knative Routes are served under. Distinct from `CONTROL_PLANE_HOST` on purpose:
  // tenant applications are other people's code, and the value here decides whether they answer
  // inside or outside the session cookie's scope.
  "TENANT_DOMAIN",
] as const

export type Placeholder = (typeof PLACEHOLDERS)[number]

export class UnsubstitutedPlaceholderError extends Error {
  override readonly name = "UnsubstitutedPlaceholderError"

  constructor(readonly remaining: string[]) {
    super(
      `These placeholders were not substituted: ${remaining.join(", ")}. ` +
        "An unsubstituted placeholder is valid YAML and applies cleanly — it fails at image pull " +
        "or at connect, in production, rather than here.",
    )
  }
}

export class UnknownValueError extends Error {
  override readonly name = "UnknownValueError"

  constructor(readonly unknown: string[]) {
    super(
      `These values do not correspond to any placeholder: ${unknown.join(", ")}. ` +
        "A typo in a value's name would otherwise substitute nothing and be reported as success.",
    )
  }
}

/**
 * Substitute every placeholder, and refuse to return anything that still has one.
 *
 * Ordered longest-first. `REGION` is a substring of nothing here, but `ACCOUNT` would be a substring
 * of `ACCOUNT_ID` if one were ever added — and a naive replace in declaration order would turn
 * `ACCOUNT_ID` into `123456789012_ID`, which is valid YAML and wrong.
 */
export function render(
  manifest: string,
  values: Partial<Record<Placeholder, string>>,
  /**
   * Which names count as placeholders. Defaults to the real list.
   *
   * A parameter only so the ordering below can be tested. No current placeholder is a prefix of
   * another, so the real list cannot demonstrate the hazard — and a test that cannot demonstrate it
   * is one that passes with the ordering removed, which is exactly what the first version did.
   */
  known: readonly string[] = PLACEHOLDERS,
): string {
  const unknown = Object.keys(values).filter((key) => !known.includes(key))
  if (unknown.length > 0) throw new UnknownValueError(unknown)

  const ordered = [...known].sort((a, b) => b.length - a.length)

  let rendered = manifest
  for (const placeholder of ordered) {
    const value = (values as Record<string, string | undefined>)[placeholder]
    if (value === undefined) continue
    rendered = rendered.replaceAll(placeholder, value)
  }

  const remaining = known.filter((placeholder) => rendered.includes(placeholder))
  if (remaining.length > 0) throw new UnsubstitutedPlaceholderError(remaining)

  return rendered
}

/**
 * Which placeholders a manifest still contains.
 *
 * Used by `render` to refuse, and separately by CI to assert that the checked-in manifests still
 * carry the placeholders this list knows about — so adding a new one to a manifest without adding it
 * here fails rather than silently shipping unrendered.
 */
export function findPlaceholders(manifest: string): string[] {
  return PLACEHOLDERS.filter((placeholder) => manifest.includes(placeholder))
}
