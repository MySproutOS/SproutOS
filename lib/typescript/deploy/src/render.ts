/**
 * Turning the manifests in `deploy/` into something applicable.
 *
 * They are written with literal placeholders — `ACCOUNT`, `REGION`, `TAG`, `KMS_KEY_ARN` — because a
 * manifest that hard-codes an account id is a manifest that only works in one account, and one that
 * carries a templating language needs a templating engine to read.
 *
 * The substitution itself is three lines. Everything else here exists because of two failure modes.
 *
 * **An unsubstituted placeholder is valid YAML.** `image: ${IMAGE_REGISTRY}/internal-api:${TAG}`
 * passes every schema check, applies cleanly, and fails at image pull — by which point it is a
 * production incident rather than a build error. So rendering refuses to produce output with a
 * placeholder left in it.
 *
 * **A placeholder spelled as a bare word substitutes itself into things that are not holes.** This
 * used to replace the bare token, on the theory that the names were distinctive enough. They were
 * not, and both ways of failing showed up in one render:
 *
 *   * `REGION` is a substring of `AWS_REGION`, so the *name* of an environment variable became
 *     `AWS_us-central1`. Sorting longest-first — which this does, and which the comment below still
 *     explains — cannot help: `AWS_REGION` is not a placeholder, so nothing longer ever matched it.
 *   * `SESSION_COOKIE_DOMAIN` is both a placeholder and a real environment variable that the
 *     application reads, so `- name: SESSION_COOKIE_DOMAIN` became `- name: .example.com`. No
 *     amount of word-boundary care distinguishes those two: they are the same characters.
 *
 * Both produced valid YAML that applied cleanly and started pods missing the variables. The website
 * could not scope a session cookie and every sign-in silently failed at the last step.
 *
 * So a placeholder is `${NAME}`. A delimiter is the only thing that separates a hole from content
 * that looks like one, and `${…}` cannot occur by accident in a Kubernetes manifest.
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
  /**
   * The registrable domain, without a subdomain: `selloutjobs.com`.
   *
   * Separate from `CONTROL_PLANE_HOST` rather than derived from it. Deriving would mean stripping a
   * label, which is right for `app.example.com` and wrong for `app.example.co.uk` — the public
   * suffix list exists because that problem has no shortcut. The `www` host is composed from this
   * in the manifest, which is the one case where a prefix is unambiguous.
   */
  "APEX_HOST",
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
 * Substitute every `${PLACEHOLDER}`, and refuse to return anything that still has one.
 *
 * Ordered longest-first, which the delimiters make redundant and which is kept anyway: `${REGION}`
 * and `${IMAGE_REGISTRY}` cannot now collide, but the ordering costs nothing and the test that
 * asserts it is the one place the hazard is written down.
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
    rendered = rendered.replaceAll(`\${${placeholder}}`, value)
  }

  const remaining = known.filter((placeholder) => rendered.includes(`\${${placeholder}}`))
  if (remaining.length > 0) throw new UnsubstitutedPlaceholderError(remaining)

  return rendered
}

/**
 * Which placeholders a manifest still contains.
 *
 * Used by `render` to refuse, and separately by CI to assert that the checked-in manifests still
 * carry the placeholders this list knows about — so adding a new one to a manifest without adding it
 * here fails rather than silently shipping unrendered.
 *
 * Matches the delimited form only. A manifest that mentions `TAG` in a comment is not a manifest
 * with an unsubstituted placeholder in it, and treating it as one is how a real refusal gets
 * disabled by whoever is tired of the false one.
 */
export function findPlaceholders(manifest: string): string[] {
  return PLACEHOLDERS.filter((placeholder) => manifest.includes(`\${${placeholder}}`))
}
