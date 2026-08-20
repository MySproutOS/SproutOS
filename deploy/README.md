# `deploy/`

Kubernetes manifests for the platform's own workloads. Tenant workloads are not here — those are
generated per project by the control plane.

## What is validated, and what that is worth

CI runs `kubeconform -strict` against the bundled Kubernetes schemas. **`-strict` is the part that
matters**: it rejects unknown fields, and an unknown field is the failure mode that actually happens.
A typo in `readOnlyRootFilesystem` is silently ignored by the API server — the manifest applies
cleanly, reports success, and the container runs with a writable root filesystem.

`kubectl --dry-run=client` is deliberately not used. It downloads the OpenAPI schema from a live
cluster, so without one it validates nothing and fails with `connection refused` — which is not the
same as passing, and is the kind of green-looking check this repo has already been bitten by twice.

**The check checks itself.** Before validating `deploy/`, CI runs kubeconform against
`.github/fixtures/known-bad-manifest.yaml`, which contains `readOnlyRootFilesytem` — a typo the API
server would ignore — and fails the build if it is _accepted_. Three separate times in one session a
check here turned out not to be checking: `vite build` never typechecked the SPAs, `tflint` accepted
a nonexistent instance type and a nonexistent database engine, and `kubectl --dry-run=client` needs a
cluster to validate anything. A validator nobody has tried to fool is a validator nobody has tested.

**Nothing here has been applied to a cluster.** Schema-valid is not the same as correct: it does not
check that the image exists, that the secret is present, that the hostPath is mounted on the node, or
that the agent can actually read what it mounts.

## `metering/`

The DaemonSet the metering agent needs, and the reason it currently bills nothing without one.

Two mounts do the work. `/sys/fs/cgroup` is where the readings come from. `/var/lib/kubelet/pod-resources`
is how the agent learns which pod owns which cgroup **without asking the API server** — a per-node,
per-second call to the control plane asking who owns each pod is the design that takes an API server
down at scale.

That choice is also why the ServiceAccount has no Role, no ClusterRole and no bindings at all. The
agent runs on every node including tenant metal, and a credential that can list pods cluster-wide,
replicated that widely, is a credential worth stealing. The diff that adds one is the diff worth
reviewing carefully.

`maxUnavailable: 100%` is deliberate. A rolling update would leave part of the fleet unmetered for
its duration; the agent re-baselines on restart regardless, so restarting together costs one sampling
interval and doing it slowly costs a gap in the billing record.

`requests == limits` puts the pod in the Guaranteed QoS class, so the kubelet evicts tenant workloads
before it evicts the thing that bills for them.

## `platform/`

Deployments and identities for the platform's own workloads. `pg-proxy` is here in full; the other
two proxies have identities and no Deployment yet, which is stated rather than papered over.

Every ServiceAccount has **no Role and no ClusterRole**. These talk to Postgres, Valkey and
OpenSearch, not to the Kubernetes API, so a binding would be a permission nobody uses and everybody
inherits. The IRSA annotation is what actually grants anything, and it grants AWS access, not
cluster access.

`pg-proxy` has a memory limit and deliberately **no CPU limit**. It sits on the per-query path for
every tenant, and CFS throttling on a latency-sensitive proxy turns a busy moment into a visible
stall. The request is what the scheduler packs on; memory is what must not run away.

Liveness is slower and more tolerant than readiness. A proxy that misses a readiness check should
leave the endpoints list; one that misses a liveness check gets killed, dropping every session it
was holding.

## `tenant/`

The half of tenant isolation that is not the Kata VM boundary. Neither substitutes for the other: a
hypervisor stops a container escape reaching the host, and does not care which IP a guest dials.

`default-deny` names **both** `Ingress` and `Egress` in `policyTypes`. A NetworkPolicy that omits
`Egress` does not restrict egress — it is the mistake that makes one of these look applied and do
nothing.

The egress allowance is the interesting part. Tenants may reach DNS, the three proxies, and the
internet — with `except` blocks for `10/8`, `172.16/12`, `192.168/16` and **`169.254/16`**. That last
one is the instance metadata service, whose credentials belong to the node; allowing `0.0.0.0/0`
outright would hand every tenant the node's IAM role.

Reaching a backing service _only_ through a proxy is what makes the proxies a security boundary
rather than a convenience — and this is the rule that enforces it from the tenant's side.

`TENANT_NAMESPACE` is a placeholder: one namespace per project, created by the control plane, which
substitutes it.

## Not here

- **Deployments for the website, API, worker, `valkey-proxy` and `search-proxy`.** Only `pg-proxy`
  has one. The other two have ServiceAccounts and nothing to run under them.
- **The gateway** the tenant ingress policy names. The policy allows traffic from
  `app.kubernetes.io/name: gateway` in `sproutos-system`, and nothing by that name exists yet — so
  applied today, that rule admits nothing.
- **Knative**, the build pipeline, and everything that turns a tenant's repository into a running
  revision. Phase 10.
- **`kata-deploy`, the runtime classes and devmapper thin pools.** Phase 11. The tenant node group
  is labelled `katacontainers.io/kata-runtime` and nothing installs it.
- **External Secrets**, so `metering-ingest` above is a Secret somebody has to create by hand.
- **NetworkPolicies.** The plan treats the NetworkPolicy plus the Kata VM boundary as the only real
  isolation control for tenant workloads, and neither exists yet.
- **Image references are placeholders** — `ACCOUNT.dkr.ecr.REGION.amazonaws.com/...` with a literal
  `TAG`. Substituted at deploy time by a pipeline that does not exist.
