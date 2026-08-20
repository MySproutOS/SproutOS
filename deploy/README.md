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

## Not here

- **Deployments for the website, API, worker and the three proxies.** They have images and
  configuration but no manifests.
- **Knative**, the build pipeline, and everything that turns a tenant's repository into a running
  revision. Phase 10.
- **`kata-deploy`, the runtime classes and devmapper thin pools.** Phase 11. The tenant node group
  is labelled `katacontainers.io/kata-runtime` and nothing installs it.
- **External Secrets**, so `metering-ingest` above is a Secret somebody has to create by hand.
- **NetworkPolicies.** The plan treats the NetworkPolicy plus the Kata VM boundary as the only real
  isolation control for tenant workloads, and neither exists yet.
- **Image references are placeholders** — `ACCOUNT.dkr.ecr.REGION.amazonaws.com/...` with a literal
  `TAG`. Substituted at deploy time by a pipeline that does not exist.
