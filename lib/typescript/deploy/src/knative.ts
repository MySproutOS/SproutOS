import { attributionLabels } from "@lib/metering"
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
  /**
   * The runtime class the pod names, or null for none.
   *
   * Optional, and this is the same correction `sandbox.runtime_class` needed twice. It defaulted to
   * `kata-fc`, which is not a preference on a managed cluster — it is a claim. The `kata-fc`
   * RuntimeClass carries `nodeSelector: katacontainers.io/kata-runtime=true` in its `scheduling`
   * block, Kubernetes merges that into every pod naming the class, and no node in a GKE Sandbox
   * cluster has that label. Every tenant revision was `didn't match Pod's node affinity/selector`
   * — a scheduling message that mentions no runtime class, for a pod nobody asked to be a VM.
   *
   * Null means the pod is scheduled normally. What isolates a tenant then is the namespace, its
   * NetworkPolicy, and — where the node pool provides it — gVisor.
   */
  runtimeClass: string | null
  /**
   * `cold` scales to zero; `warm` keeps one instance. ADR 0024.
   *
   * Recorded on the deployment rather than read from the project, for the reason
   * `runtime_class` is: a deployment is a historical fact, and a later settings change must not
   * re-describe how a revision that already ran was configured.
   */
  scaleMode: "cold" | "warm"
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
      /*
        Pod labels, and the reason this member exists.

        The labels on `metadata` above belong to the *Service*. The metering agent reads labels off
        each **pod** on its node, so a Service label is invisible to it no matter what it says — and
        this renderer had no pod labels at all. Every tenant revision the platform ever served was
        unattributable, which is to say free.
      */
      metadata: { labels: Record<string, string>; annotations: Record<string, string> }
      spec: {
        runtimeClassName?: string
        tolerations?: { key: string; operator: string; value: string; effect: string }[]
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
  /**
   * Who pays for it.
   *
   * The namespace already encodes this — `tenant-<organization id>` — and deriving it back out of
   * a string would work. It is passed instead, because an id recovered by parsing a name is an id
   * that breaks silently the day the naming changes, and what breaks is the billing.
   */
  organizationId: string
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
 * How long a `cold` revision is kept after its last request.
 *
 * Not zero. Knative's default tears the instance down as soon as the stable window closes, so a
 * second visitor thirty seconds behind the first pays a full cold start — and bursty traffic is the
 * normal shape for a small site. Five minutes covers a person clicking around and costs nothing
 * overnight, which is the case `cold` exists for.
 */
const COLD_SCALE_DOWN_DELAY = "5m"

/**
 * The autoscaling annotations for a scale mode. ADR 0024.
 *
 * `warm` is `min-scale: 1` and nothing more exotic. Vercel's Fluid keeps one instance too, and
 * theirs is *paused* between requests — "no CPU or memory charges apply until the next
 * invocation." What that pause actually is, they have never published; the earlier version of this
 * comment guessed "a Firecracker snapshot" and their own isolation documentation contradicts it.
 * Either way Knative has no retained-but-paused revision, so here a kept instance is a running one.
 *
 * What makes `warm` cheap here is the other end: `services/metering-agent` bills measured CPU and
 * memory, not reserved size, so an idle instance's metered cost is close to nothing. Vercel stops
 * the clock; SproutOS measures the work. Different mechanism, same bill.
 */
export function scaleAnnotations(mode: "cold" | "warm"): Record<string, string> {
  return mode === "warm"
    ? { "autoscaling.knative.dev/min-scale": "1" }
    : {
        "autoscaling.knative.dev/min-scale": "0",
        "autoscaling.knative.dev/scale-down-delay": COLD_SCALE_DOWN_DELAY,
      }
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
        metadata: {
          labels: {
            "app.kubernetes.io/part-of": "sproutos",
            "sproutos.dev/deployment-kind": deployment.kind,
            // What makes the revision billable. See `attributionLabels`.
            ...attributionLabels(project.organizationId, project.id),
          },
          annotations: scaleAnnotations(deployment.scaleMode),
        },
        spec: {
          /*
            The taint a GKE Sandbox node carries.

            `sandbox.gke.io/runtime=gvisor:NoSchedule` keeps ordinary workloads off a node running a
            user-space kernel. A pod naming `runtimeClassName: gvisor` without this toleration stays
            Pending with no indication that a taint rather than capacity is the reason.

            Unconditional, matching `@lib/sandbox`'s spec for the same reason given there: a
            toleration for a taint no node carries does nothing, and a conditional would be a second
            place for the two to disagree.
          */
          tolerations: [
            {
              key: "sandbox.gke.io/runtime",
              operator: "Equal",
              value: "gvisor",
              effect: "NoSchedule",
            },
          ],
          // The hypervisor, per ADR 0012: `kata-fc` for deploys, `kata-clh` for anything needing a
          // live filesystem, `gvisor` on a managed cluster. Carried on the row rather than
          // hardcoded, and **omitted entirely when there is none** — `runtimeClassName: null` is
          // not "no runtime class", it is a field the API server rejects.
          ...(deployment.runtimeClass === null
            ? {}
            : { runtimeClassName: deployment.runtimeClass }),
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
