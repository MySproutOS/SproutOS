import { attributionLabels } from "@lib/metering"
/**
 * The pod a piece of untrusted work runs in.
 *
 * Everything here is a property that has to hold whether or not there is a hypervisor underneath.
 * `runtimeClassName` is the VM boundary and it is *optional* — a trial cluster has no bare-metal
 * node pool and therefore no Kata runtime class — so the isolation cannot rest on it alone.
 *
 * What it rests on instead is the namespace. A sandbox runs in the tenant's own namespace, where
 * `deploy/tenant/network-policy.yaml` is already in force: default-deny both ways, egress to DNS,
 * to the three data-plane proxies, and to `0.0.0.0/0` *minus* 10/8, 172.16/12, 192.168/16 and
 * 169.254/16. That last exclusion is the one that matters for a URL a customer typed — it is what
 * stops `action.http` reaching the API server, another tenant's database, or the instance metadata
 * service whose credentials are the node's.
 *
 * The rest — no service-account token, no root, no capabilities, a read-only root filesystem, hard
 * resource limits and a deadline — are the things that make the pod itself uninteresting to
 * escape from.
 */

export type SandboxSpec = {
  /** The tenant namespace. This is the security boundary; it is not a label. */
  namespace: string
  /**
   * Who pays for the compute this burns.
   *
   * Required, not optional. A sandbox with no attribution is a sandbox nobody is charged for, and
   * every one of them was: the pod template carried `sproutos.dev/sandbox` and nothing the metering
   * agent reads. Making it required means a new caller cannot forget — the compiler asks.
   */
  organizationId: string
  /** The project, when the work belongs to one. A standalone service has none. */
  projectId?: string
  /** Distinguishes one run from another. Becomes the Job name, so it must be a DNS label. */
  name: string
  image: string
  command: string[]
  env?: Record<string, string>
  /** Wall clock. The Job is killed by Kubernetes at this, not by a caller that may have gone away. */
  timeoutSeconds?: number
  cpu?: string
  memory?: string
  /**
   * `kata-fc` or `kata-clh` where a runtime class exists.
   *
   * Absent means the pod runs under the node's default runtime, which is a namespace and a
   * NetworkPolicy and not a VM. That is a real reduction in isolation and it is deliberate rather
   * than accidental: refusing to run at all on a cluster without Kata would mean the feature only
   * exists on metal, and the alternative that was actually shipping was running this code *in the
   * control plane's own pod*, which is worse in every way.
   */
  runtimeClassName?: string
}

/** Two minutes. Long enough for an HTTP call or a short script, short enough to bound the bill. */
export const DEFAULT_TIMEOUT_S = 120

export type SandboxJob = Record<string, unknown>

/** Where a Job lives in the API. */
export function jobPath(namespace: string, name: string): string {
  return `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`
}

/** Where a namespace's pods live, filtered to one Job's. */
export function podsForJobPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`job-name=${name}`)}`
}

/** Where one pod's logs live. */
export function podLogPath(namespace: string, pod: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?container=work&tailLines=2000`
}

export function sandboxJob(spec: SandboxSpec): SandboxJob {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: {
        "app.kubernetes.io/part-of": "sproutos",
        "sproutos.dev/sandbox": "true",
      },
    },
    spec: {
      // No retries. Untrusted work that failed will fail the same way, and each attempt is billed
      // compute; whether to try again is a decision for the caller that knows why it ran.
      backoffLimit: 0,
      activeDeadlineSeconds: spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
      template: {
        metadata: {
          labels: {
            "sproutos.dev/sandbox": "true",
            // Pod labels, which is where the metering agent looks. The Job's own labels above are
            // invisible to it.
            ...attributionLabels(spec.organizationId, spec.projectId),
          },
        },
        spec: {
          restartPolicy: "Never",
          /*
            The taint a sandbox node carries.

            GKE taints a GKE Sandbox node `sandbox.gke.io/runtime=gvisor:NoSchedule` so ordinary
            workloads do not land on it — the node runs a user-space kernel and everything on it
            pays for that. A pod naming `runtimeClassName: gvisor` without this toleration stays
            Pending forever with no indication that the reason is a taint rather than capacity,
            which is a bad afternoon.

            Unconditional rather than added only when the runtime class is gVisor: a toleration for
            a taint no node carries does nothing at all, and a conditional here would be a second
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
          ...(spec.runtimeClassName === undefined
            ? {}
            : { runtimeClassName: spec.runtimeClassName }),
          /*
            No service-account token.

            The default projects one into every pod, and a token is a credential for the API server
            — the single most valuable thing in the cluster to hand to code a customer wrote. The
            NetworkPolicy blocks the API server's address as well, and these are deliberately both:
            a policy is a runtime object somebody can delete, and this is not.
          */
          automountServiceAccountToken: false,
          containers: [
            {
              name: "work",
              image: spec.image,
              command: spec.command,
              env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
              resources: {
                requests: { cpu: spec.cpu ?? "100m", memory: spec.memory ?? "128Mi" },
                // A limit on both, unlike the platform's own workloads. Those are ours and are
                // trusted to behave; this is not, and an unbounded CPU limit on untrusted code is
                // a free crypto miner on a node somebody else is also using.
                limits: { cpu: spec.cpu ?? "500m", memory: spec.memory ?? "256Mi" },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65534,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
              volumeMounts: [{ name: "scratch", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "scratch", emptyDir: { sizeLimit: "256Mi" } }],
        },
      },
    },
  }
}
