/**
 * The one method this needs, named structurally.
 *
 * `createKubeClient` has an inferred return type and exports no `KubeClient`, and widening it here
 * would be a second definition to keep in step. A caller passes the real client; a test passes a
 * spy.
 */
type Applier = { apply: <T>(path: string, object: unknown) => Promise<T> }

/**
 * The namespace a tenant's workloads run in, and the policies that make it a boundary.
 *
 * ## Why this file exists
 *
 * `deploy/tenant/network-policy.yaml` has described this isolation since the compute phase, and
 * nothing applied it. The manifest is parameterized on `${TENANT_NAMESPACE}`, so it is rendered for
 * one namespace at a time — by a person, at a terminal, for a namespace they already knew about.
 * Meanwhile every code path that runs customer code (`deployRevision`, `runWorkflow`, the dev
 * sandbox route) computed `tenantNamespace(organizationId)` and applied a workload into it, on the
 * assumption that somebody had prepared it.
 *
 * On the trial cluster somebody had: exactly one namespace existed, because I created it by hand
 * while verifying the workflow sandbox, and applied the policy by hand straight afterwards. So the
 * isolation test passed — a pod really could not reach the instance-metadata endpoint — and proved
 * a property of that one hand-made namespace rather than of the system. The second organization to
 * open a dev sandbox got `namespaces "tenant-…" not found`.
 *
 * The two failure modes are not equally loud, and the quiet one is the dangerous one:
 *
 * - The namespace does not exist. The apply fails, the customer sees an error, somebody looks.
 * - The namespace exists **without** the policies — created by an earlier hand, or by a path that
 *   made the namespace and stopped there. Customer code runs with unrestricted egress and nothing
 *   anywhere reports a problem.
 *
 * `ensureTenantNamespace` is therefore not "create it if missing". It applies the namespace *and*
 * all three policies, every time, before any workload goes in. Server-side apply makes that cheap
 * and idempotent, and it repairs a namespace whose policies were deleted rather than trusting that
 * a namespace which exists is a namespace which is fenced.
 *
 * ## Keeping this and the YAML in step
 *
 * The objects below are the same objects as `deploy/tenant/network-policy.yaml`, and
 * `tenant-namespace.test.ts` renders that file and asserts they are deeply equal. A divergence here
 * is a security bug of the same kind as an SRN divergence, so it is checked the same way: one
 * source, asserted from both sides, rather than two definitions maintained in parallel by hope.
 */

/** Applied to everything this file creates, matching the manifests. */
const LABELS = { "app.kubernetes.io/part-of": "sproutos" }

type NetworkPolicy = {
  apiVersion: "networking.k8s.io/v1"
  kind: "NetworkPolicy"
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: Record<string, unknown>
}

type Namespace = {
  apiVersion: "v1"
  kind: "Namespace"
  metadata: { name: string; labels: Record<string, string> }
}

export function tenantNamespaceObject(namespace: string): Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        ...LABELS,
        // Read by the NetworkPolicies of *other* namespaces, and by anything asking which
        // namespaces hold customer code. `kubernetes.io/metadata.name` is set by the API server and
        // is what the selectors below match on; this one says what the namespace is *for*.
        "sproutos.dev/tenant": "true",
      },
    },
  }
}

/**
 * The three policies, in the order they must be applied.
 *
 * `default-deny` first is deliberate. If the allows landed first and the deny failed, the namespace
 * would be open; this way a partial apply leaves it closed. A closed namespace is a broken tenant,
 * which somebody notices — an open one is a silent hole.
 */
export function tenantNetworkPolicies(namespace: string): NetworkPolicy[] {
  const policy = (name: string, spec: Record<string, unknown>): NetworkPolicy => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace, labels: { ...LABELS } },
    spec,
  })

  return [
    // Both policy types named explicitly. A NetworkPolicy that omits `Egress` does not restrict
    // egress — that is the mistake that makes one of these look applied and do nothing.
    policy("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),

    policy("allow-ingress-from-gateway", {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "kourier-system" },
              },
              podSelector: { matchLabels: { app: "3scale-kourier-gateway" } },
            },
            {
              // The activator, not only the gateway. A scaled-to-zero revision is reached through
              // the activator, so a namespace that admits only Kourier serves every request except
              // the first one after a scale-down — which is the request a cold start exists for.
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "knative-serving" },
              },
              podSelector: { matchLabels: { app: "activator" } },
            },
          ],
        },
      ],
    }),

    policy("allow-egress", {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          // The tenant's own data plane, through the proxies that authorize it. Not the databases
          // themselves — the private-range exception below is what stops a tenant dialing the
          // Postgres cluster directly and skipping `pg-proxy`'s `SET ROLE`.
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "sproutos-system" },
              },
              podSelector: {
                matchExpressions: [
                  {
                    key: "app.kubernetes.io/name",
                    operator: "In",
                    values: ["pg-proxy", "valkey-proxy", "search-proxy"],
                  },
                ],
              },
            },
          ],
        },
        {
          // The internet, minus every private range and link-local. 169.254.0.0/16 is the one that
          // matters most: it carries the cloud instance-metadata endpoint, and a node's IAM identity
          // with it.
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
              },
            },
          ],
        },
      ],
    }),
  ]
}

/**
 * Make the namespace exist and be fenced. Safe to call before every workload.
 *
 * Applies rather than creates: the point is that the policies are in force *now*, not that they
 * were in force when the namespace was first made.
 */
export async function ensureTenantNamespace(client: Applier, namespace: string): Promise<void> {
  await client.apply(namespacePath(namespace), tenantNamespaceObject(namespace))

  for (const policy of tenantNetworkPolicies(namespace)) {
    await client.apply(networkPolicyPath(namespace, policy.metadata.name), policy)
  }
}

/** Where a Namespace lives in the API. */
export function namespacePath(namespace: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}`
}

/** Where a NetworkPolicy lives in the API. */
export function networkPolicyPath(namespace: string, name: string): string {
  return `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies/${encodeURIComponent(name)}`
}
