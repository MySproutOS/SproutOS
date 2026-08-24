/**
 * What a tenant's site is called.
 *
 * All that survives of the Knative renderer, and the only part of it that was ever about SproutOS
 * rather than about Kubernetes. Compute moved to Lambda (ADR 0026); hostnames did not change.
 */

/** How much of a project's id goes into the host label. */
const MAX_LABEL = 63

/** Enough of the project id to keep two same-named projects apart. */
const DISCRIMINATOR_LENGTH = 6

export type ProjectSpec = {
  id: string
  slug: string
  /**
   * Who pays for it.
   *
   * The namespace already encodes this — `tenant-<organization id>` — and deriving it back out of
   * a string would work. It is passed instead, because an id recovered by parsing a name is an id
   * that breaks silently the day the naming changes, and what breaks is the billing.
   */
  organizationId: string
}

/** Only what the label depends on. */
export type DeploymentSpec = {
  kind: string
  prNumber: number | null
}

/**
 * The single DNS label a tenant's site is served from.
 *
 * **Why there is a discriminator in here at all.** `project.slug` is unique per *organization*
 * (`project_org_slug_live_key`), not globally. The domain template is
 * `{{.Name}}.{{.Domain}}` — it has to be, because an ACM wildcard covers exactly one label and the
 * default `{{.Name}}.{{.Namespace}}.{{.Domain}}` produces two — so the service name *is* the whole
 * label and must be globally unique. Two organizations each with a project called `myapp` would
 * otherwise be issued the same hostname, and the second one to deploy would take over the first
 * one's traffic.
 *
 * ADR 0018 writes the preview form as `pr-42--myapp.sprout.run`, with no discriminator, and has the
 * same collision. **This is a deviation from a literal reading of that ADR and is worth a decision**
 * — the alternative is making project slugs globally unique, which is a product change (it means
 * telling a customer their project name is taken by a stranger).
 *
 * The `--` separator on previews is kept exactly as the ADR specifies, and matches Knative's own
 * tag convention: a slug may itself contain single dashes, so `pr-42-my-app` is ambiguous about
 * where the tag ends.
 */
export function hostLabel(
  project: ProjectSpec,
  // Only the two fields it reads. The rest of `DeploymentSpec` describes a container — image,
  // runtime class, concurrency — and the Lambda path has none of them to offer.
  deployment: Pick<DeploymentSpec, "kind" | "prNumber">,
): string {
  // The tail of a UUIDv7, which is the random part. The head is a millisecond timestamp, so two
  // projects created in the same tick would share it.
  const discriminator = project.id.replaceAll("-", "").slice(-DISCRIMINATOR_LENGTH)
  const prefix =
    deployment.kind === "preview" && deployment.prNumber != null
      ? `pr-${deployment.prNumber}--`
      : ""

  // Trim the slug rather than the discriminator or the prefix: losing the discriminator loses
  // uniqueness, and losing the prefix points a preview at production.
  const room = MAX_LABEL - prefix.length - DISCRIMINATOR_LENGTH - 1
  const slug = project.slug.slice(0, Math.max(1, room)).replace(/-+$/, "")

  return `${prefix}${slug}-${discriminator}`
}
