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

Deployments and identities for the platform's own workloads: the website, the API, the worker, and
all three data-plane proxies.

The worker is separate from the API not for scale but because a long job holding an event-loop turn
inside the API delays every request behind it, and a worker that needs restarting should not take the
API down with it. Two replicas, not three: the job runner claims with `FOR UPDATE SKIP LOCKED`, so
workers never contend and replicas buy throughput — the second one is for availability during a
rolling deploy. Its `terminationGracePeriodSeconds` is 120, because a worker holding a lease should
finish the job; the default 30 kills mid-job and leaves the lease to expire, and re-running a job
that was nearly done is work paid for twice.

`website` is the one Deployment with `readOnlyRootFilesystem: false`. Next.js writes its incremental
cache to disk, and an `emptyDir` over `.next/cache` is the tidy answer — left unwritten and flagged
rather than guessed, because getting that mount path wrong fails at request time on a cache miss
rather than at startup, which is the worst place to discover it.

The three proxies are separate Deployments rather than one because they scale on different signals —
queue traffic is bursty per job, search traffic is per request — and because a bad deploy of one
should not take the other's tenants offline. `search-proxy` gets a larger memory limit than the other
two: it buffers request and response bodies to rewrite index names, so its working set follows the
size of a tenant's bulk uploads.

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

## `secrets/`

What creates the Secrets everything else reads. Without these, five Secrets do not exist and every
workload in `platform/` and `metering/` sits in `CreateContainerConfigError` — so this is the
manifest that makes the rest of the directory something other than decoration.

The store authenticates with `jwt` and a service account, not static keys. A `SecretStore` holding an
AWS access key would be a long-lived credential sitting in the cluster **in order to fetch
credentials**, which is a loop worth refusing.

`control-plane-database` reads what RDS wrote. `manage_master_user_password` in `tofu/database.tf`
means the password lives in Secrets Manager and never in OpenTofu state, so the URL is assembled from
those fields by a template rather than being stored as one string somebody has to keep in step.

`refreshInterval: 1h` everywhere. Fetching once means a rotated password keeps working until each pod
restarts and then stops working for all of them — a failure that arrives hours after its cause, all
at once.

Non-secret configuration lives in `platform/config.yaml` as ConfigMaps instead. Putting a hostname in
Secrets Manager would mean a KMS decrypt and an API call to learn something printed in the OpenTofu
outputs — and treating everything as secret is how the things that genuinely are stop getting the
attention they need.

## `tenant/runtime-classes.yaml`

Two Kata runtime classes, and the split is a constraint rather than a preference. **Kata with
Firecracker has no virtio-fs**, so its only rootfs path is a devmapper thin snapshot — anything
needing a live filesystem cannot use it. `kata-fc` runs workflow and deploy workloads; `kata-clh`
runs agent sessions and dev sandboxes, which write files.

Both declare `overhead.podFixed`. The VM costs memory and a little CPU before the workload starts,
and without declaring it the scheduler packs a node to its apparent capacity and then evicts, because
the sum of the guests exceeds what the host has.

`kata-deploy` installs the handlers these name. **Nothing here installs `kata-deploy`**, so applied
today both classes reference a handler no node provides and every pod using them stays Pending.

## Not here

- ~~**The gateway** the tenant ingress policy names.~~ Fixed — the policy now names Knative's actual
  data path, and which component that is turned out not to be the obvious one. See below.
- **The External Secrets operator itself.** `secrets/` declares what it should fetch; nothing
  installs the controller that would act on it, so those resources are currently inert too.
- **Applying any of it.** `.github/workflows/deploy.yml` builds the images, renders the manifests
  and validates the result — and deliberately stops there. A workflow that would `kubectl apply` on
  merge, written blind and never rehearsed, is a worse artefact than one that builds the inputs and
  hands them over.
- **Substituting the placeholders.** `ACCOUNT`, `REGION`, `TAG`, `TENANT_NAMESPACE`, `KMS_KEY_ARN`
  and the three tenant hostnames are literal strings in these files. A deploy pipeline fills them
  from the OpenTofu outputs of the same name. That is `bin/render-manifests.mjs`, driven by the
  deploy workflow — so this one is now done, and the entry stays only to say that the _checked-in_
  files are templates rather than manifests.
- **Knative**, the build pipeline, and everything that turns a tenant's repository into a running
  revision. Phase 10.
- **`kata-deploy` itself and the devmapper thin pools.** Phase 11. The runtime classes above name
  handlers that only `kata-deploy` provides, and the tenant node group is labelled for it — but
  nothing installs it, so both classes are currently references to nothing.
- **External Secrets**, so `metering-ingest` above is a Secret somebody has to create by hand.
- **A cluster to apply this to that is not a laptop.** See below — it has now been applied to a real
  one, but a `kind` node is not EKS: no Kata, no metal, no ALB, no IRSA.

## Applied

These were schema-valid and had never touched an API server. They have now been applied to a real
Kubernetes cluster — `kind`, one node — with the images built locally and loaded in. All six
Deployments reached full replicas and the DaemonSet reached 1/1.

Applying it found four things `kubeconform` structurally cannot:

1. **Nothing created the namespaces.** `sproutos-system` was declared as the _second_ document
   inside `metering/rbac.yaml`, which sorts after the DaemonSet that lives in it; `external-secrets`
   and the tenant namespace were never declared at all. A fresh apply failed on its first document,
   twenty-five times over. A Deployment naming a namespace that does not exist is perfectly valid
   YAML. Now `00-namespaces.yaml`, which sorts and applies first.
2. **The metering DaemonSet could never create a pod.** It reads cgroup v2 through `hostPath`, and
   `hostPath` is forbidden under `restricted` _and_ `baseline`. `sproutos-system` enforces
   `restricted` — and its own comment claimed the agent complied. Desired 1, current 0, silently,
   because a DaemonSet that creates no pods is not an error anywhere but its own event log. It now
   has its own `privileged` namespace, so the other six workloads keep enforcing `restricted`.
3. **`valkey-proxy` could not start with a hostname.** It parsed its backend into a Rust
   `SocketAddr`, which only accepts a literal IP. Production hands it an ElastiCache endpoint — a
   DNS name — so it would have crash-looped on `invalid socket address syntax` forever. Every test
   passed because the test config is `127.0.0.1:41023`. It now takes a string and resolves per
   connection, which also survives a failover that moves the endpoint.
4. **The website bound to one interface.** Next's standalone server binds
   `process.env.HOSTNAME || "0.0.0.0"`, and the container runtime sets `HOSTNAME` to the pod name,
   which `/etc/hosts` maps to the pod IP. The pod passed readiness and served Service traffic —
   both target the pod IP — while `localhost` inside the pod refused connections, breaking
   `kubectl port-forward` and anything else in-pod. A pod whose own name failed to resolve would
   not have bound at all.

Verified afterwards, through the cluster's own Services: the API answers `/health`, `/ready` (against
a real Postgres) and `/v1/auth/me`; the website serves `/`, `/store` and `/login` and redirects
`/dashboard` to `/login` when unauthenticated, so `proxy.ts` classifies correctly in-cluster.

Also confirmed by the failure of something else: a stock `postgres:18-alpine` was rejected outright
by the `restricted` standard on `sproutos-system`, which is the evidence that the six SproutOS
workloads satisfying it are actually satisfying something.

## Tenant traffic

A tenant's application now serves a request, isolated, and this is verified in CI rather than
asserted.

Getting there needed the ingress policy corrected, and the correction was not the one that reads
correctly. Measured on a cluster with a CNI that enforces NetworkPolicy:

| ingress rule           | tenant app reachable |
| ---------------------- | -------------------- |
| no rule                | no                   |
| gateway (Kourier) only | **no**               |
| activator only         | yes                  |
| both                   | yes                  |

The **activator** is what connects to the revision, not the gateway. Knative's default
`target-burst-capacity` of 200 keeps the activator in the data path instead of letting the gateway
route straight through, so on a default install it is the activator's identity that has to be
allowed. Naming only the gateway — the intuitive rule — produces a tenant application that cannot be
reached at all. Both are named, because the activator steps out of the path once a revision has
capacity beyond the burst target.

### The CNI has to enforce the thing you are testing

The first run of this was done on a stock `kind` cluster and produced a confident, wrong answer:
every configuration passed, including deleting the ingress policy outright. `kindnet` accepts
NetworkPolicy objects and does not enforce them.

So the CI cluster now disables the default CNI and installs Calico, and the test asserts both
directions:

- through the gateway, the app **must** answer; and
- straight at the pod's IP from another namespace, it **must not**.

The negative half is the one that keeps the positive half honest. Without it the whole test passes
just as happily on a cluster that ignores NetworkPolicy entirely — which is precisely the false
negative that let an ingress rule naming a nonexistent pod survive review.

## `knative/`

`config-network.yaml`, applied after Knative Serving is installed, and both settings in it exist
because the defaults are wrong for this platform.

**The domain template.** Knative's default is `{{.Name}}.{{.Namespace}}.{{.Domain}}`, which produced
`myapp.tenant-abc123.sprout.run` — two labels in front of the apex. ADR 0018 is explicit that an ACM
wildcard covers exactly one; that is the entire reason preview hosts use `pr-42--myapp` rather than
`pr-42.myapp`. The default violates the same constraint for **every** tenant site, so
`*.sprout.run` would fail TLS for every production deployment on the platform.

Nothing caught it because nobody had run Knative and read the URL it hands back. The Service reports
`Ready: True` and publishes a `status.url` that cannot be certificated. CI now asserts the shape of
that URL directly.

**The tag template.** Knative's default is `{{.Tag}}-{{.Name}}`, a single dash. ADR 0018 requires
`pr-42--myapp`, and the double dash is load-bearing: a project slug may contain single dashes
(`my-app`), so `pr-42-my-app` is ambiguous about where the tag ends.
