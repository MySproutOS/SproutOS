# 0004. Upstream defaults that do not survive here

None of these is a bug in the upstream project. Each is a sensible default that does not fit this
platform's constraints, and **none of them announces itself** — the resource is accepted, the
controller reports healthy, and the wrong thing happens quietly.

## Knative's `Ready` condition means two different things

The top-level `Ready` condition goes **`False` with reason `RevisionMissing` while a healthy first
deploy is still coming up** — the same status, the same reason and the same message it carries when
the revision has failed for good:

```
ConfigurationsReady  False  reason=RevisionFailed   msg=Revision "app-00001" failed: Unable to fetch image
Ready                False  reason=RevisionMissing  msg=Configuration "app" does not have any ready Revision
```

Reading `Ready: False` as failure marks every good deployment as errored about a second after
creating it. The terminal signal is `ConfigurationsReady` with reason `RevisionFailed`, and its
message is the one worth showing a customer — `Ready`'s says only that there is no ready revision,
which they can already see.

`revisionOutcome` is a pure function so the rule is pinned by tests that need no cluster.

## Knative's domain template produces hosts that cannot be certificated

The default is `{{.Name}}.{{.Namespace}}.{{.Domain}}`, which yields `myapp.tenant-abc123.sprout.run`
— **two labels** in front of the apex. [ADR 0018](../adr/0018-domains.md) is explicit that an ACM
wildcard covers exactly one; that constraint is the entire reason preview hosts are `pr-42--myapp`
rather than `pr-42.myapp`.

The default breaks it for _every_ tenant site. There is no error state to notice: the Service reports
`Ready: True` and publishes a `status.url` that simply cannot be certificated.

The tag template needed changing too — Knative's default is a single dash, and a project slug may
itself contain dashes, so `pr-42-my-app` is ambiguous about where the tag ends.

## Knative refuses `runtimeClassName` by default

```
admission webhook denied the request: must not set the field(s): spec.template.spec.runtimeClassName
```

`kubernetes.podspec-runtimeclassname` is off by default and nothing here had turned it on, because
nothing here had ever created a Knative Service. With it off, **the only way to deploy a tenant is to
omit the field** — silently putting customer code on the shared host kernel, with NetworkPolicies as
the only remaining boundary. ADR 0012's entire hypervisor story rested on one line.

Set to `enabled` rather than `allowed`: `allowed` permits a Service that omits the field, and a
tenant quietly running without a hypervisor is exactly what should be impossible.

## GKE refuses `system-node-critical` outside `kube-system`

A ResourceQuota restricts it, so the metering DaemonSet was rejected: `insufficient quota to match
these scopes`. Desired 2, current 0, explained nowhere but its own event log.

The replacement had to be a custom PriorityClass — and the first value chosen, just under
`system-cluster-critical`, was refused too: **Kubernetes caps user-defined priority at
1,000,000,000.** That ceiling exists precisely so nothing outside `kube-system` can outrank the
control plane, and it is the right constraint.

## The Kubernetes API server does not use a public CA

The metering agent ships in a `scratch` image with the public CA bundle, which is correct for
reaching the control plane over TLS and useless for reaching the API server — it signs with the
_cluster's_ CA. Every request failed the handshake while the pod looked perfectly healthy: Running,
sampling cgroups, attributing nothing.

The CA is projected into the pod alongside the token, so the fix needed no extra mount.

## `reqwest` error messages say nothing

`error sending request for url (…)` — no mention of TLS, of the certificate, of anything. That cost a
deploy cycle. The whole `anyhow` chain is logged now.

## GKE nodes cannot pull from Artifact Registry by default

The node's default compute service account has the `devstorage.read_only` scope, which covered the
old Container Registry. Artifact Registry needs an IAM grant. `roles/artifactregistry.reader`, scoped
to the one repository rather than the project.

## A build's egress policy must name the registry explicitly

"The internet, minus everything private" is the right rule for a build that runs `npm install` — and
it blocks the push. **ECR reached through a VPC interface endpoint, the recommended and cheaper
setup, resolves to a private address.** The build then fails minutes in with an i/o timeout that
reads like a flaky network. Observed exactly that way against a local registry on `172.30.0.3`.

`BUILD_REGISTRY_CIDR` is `0.0.0.0/0` for public ECR, where the rule costs nothing.

## A foreign key violation is a 500, and a 500 retries forever

Not an upstream default — one of ours, and it belongs here because it has the same shape: correct
code, valid data, and a failure that compounds instead of surfacing.

A pod label can name an organization or a project that has since been deleted. Inserting the usage
anyway violates `usage_event_organization_id_fkey`, the route answers 500, and **the agent retries
that batch forever** — so one stale label stalls a whole node's usage stream behind a batch that can
never succeed. Found by posting a real batch from a real node, not by any test, because every test
seeded a real organization first.

The two cases need different remedies, and the difference is the interesting part:

- **Unknown organization: drop the event.** There is nobody to bill.
- **Unknown project: keep the event, null the project.** The organization is real and genuinely
  consumed the resource; only the sub-attribution is unverifiable. Dropping it would lose revenue for
  work that was actually done.

Both are counted in the response, because a node steadily submitting usage for something that does
not exist is a stale label and nothing else would say so.
