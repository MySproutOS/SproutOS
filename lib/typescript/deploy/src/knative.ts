/**
 * A `deployment` row rendered as a Knative Service.
 *
 * Pure: no cluster, no database. The decisions here — what a tenant's hostname is, which hypervisor
 * runs the pod, what it is allowed to consume — are the ones worth being able to test without
 * either.
 */

/** The 63-character limit on a single DNS label, which the service name becomes. */
const MAX_LABEL = 63

/** How much of a project's id goes into the host label. */
const DISCRIMINATOR_LENGTH = 6

export type DeploymentSpec = {
  /** `production` | `preview` | `branch`. */
  kind: string
  /** Present on previews. */
  prNumber?: number | null
  imageUri: string
  /** `kata-fc` or `kata-clh`. */
  runtimeClass: string
  containerConcurrency: number
  memoryMb: number
  maxDurationS: number
}

/**
 * The subset of a Knative Service this renders.
 *
 * Written out rather than returning `Record<string, unknown>`: the callers that matter are the
 * tests, and an untyped object turns every assertion into a cast — which is how a renderer comes to
 * be tested against the shape the test author imagined rather than the one it produces.
 */
export type KnativeService = {
  apiVersion: "serving.knative.dev/v1"
  kind: "Service"
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    template: {
      spec: {
        runtimeClassName: string
        containerConcurrency: number
        timeoutSeconds: number
        containers: {
          image: string
          resources: { limits: { memory: string }; requests: { memory: string } }
          securityContext: {
            allowPrivilegeEscalation: boolean
            capabilities: { drop: string[] }
            seccompProfile: { type: string }
          }
        }[]
      }
    }
  }
}

export type ProjectSpec = {
  id: string
  slug: string
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
export function hostLabel(project: ProjectSpec, deployment: DeploymentSpec): string {
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

/**
 * The Knative Service for one deployment.
 *
 * `containerConcurrency` and the request timeout come from the row rather than a constant because
 * they are per-project settings a customer can change, and both are billing-relevant: concurrency
 * decides how many requests share one metered container, and the timeout bounds what a single
 * request can cost.
 */
export function knativeService(
  project: ProjectSpec,
  deployment: DeploymentSpec,
  namespace: string,
): KnativeService {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: {
      name: hostLabel(project, deployment),
      namespace,
      labels: {
        "app.kubernetes.io/part-of": "sproutos",
        "sproutos.dev/project": project.id,
        "sproutos.dev/deployment-kind": deployment.kind,
      },
    },
    spec: {
      template: {
        spec: {
          // The hypervisor, per ADR 0012: `kata-fc` for deploys, `kata-clh` for anything needing a
          // live filesystem. Carried on the row rather than hardcoded because the choice differs
          // per workload and is not something this renderer should be deciding.
          runtimeClassName: deployment.runtimeClass,
          containerConcurrency: deployment.containerConcurrency,
          timeoutSeconds: deployment.maxDurationS,
          containers: [
            {
              image: deployment.imageUri,
              resources: {
                limits: { memory: `${deployment.memoryMb}Mi` },
                // A request equal to the limit: tenant pods are billed on what they reserve, and a
                // burstable pod would let one tenant's spike be paid for out of another's headroom.
                requests: { memory: `${deployment.memoryMb}Mi` },
              },
              // Deliberately not `runAsNonRoot`. Tenant namespaces enforce `baseline`, not
              // `restricted`, because customer images routinely run as root; demanding otherwise
              // here would reject images the platform has promised to run. The isolation that
              // matters for tenant code is the Kata VM boundary and the NetworkPolicies.
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      },
    },
  }
}
