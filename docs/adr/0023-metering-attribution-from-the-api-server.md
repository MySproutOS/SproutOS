# 0023. The metering agent reads pod attribution from the API server

- Status: Accepted
- Date: 2026-08-20
- Amends: [0014](0014-one-metering-pipeline.md)

## Context

[ADR 0014](0014-one-metering-pipeline.md) settled that usage flows through one pipeline: a cgroup v2
DaemonSet, HMAC-signed batches, one ingest route. It did not settle how the agent learns _whose_
cgroup it is looking at, and the implementation took a position in a comment:

> Pod labels come from the kubelet's own view, not from the API server. A per-node, per-second call
> to the control plane to ask who owns each pod is the design that takes an API server down at scale.

The reasoning is right and the mechanism does not work. The kubelet's pod-resources socket reports
**devices and containers**, not pod _labels_ — and the attribution SproutOS bills on,
`sproutos.dev/organization-id`, is a label. The socket would have needed a second lookup against the
API server to be useful.

What shipped instead was a hardcoded empty map with a comment saying so. The agent ran, sampled every
cgroup on the node, and **attributed nothing to anyone**.

## Decision

The agent lists this node's pods from the API server, filtered with
`fieldSelector=spec.nodeName=<node>`, **once per thirty-second refresh interval** — not once per
sample. The design 0014's comment rejected was a per-node, per-second call; this is one request per
node every thirty seconds.

The cgroup path is derived from the pod UID and QoS class rather than looked up:

```
kubepods.slice/kubepods-<qos>.slice/kubepods-<qos>-pod<uid_with_underscores>.slice
```

Guaranteed pods have no QoS level in their path. The UID is systemd-escaped — underscores, because a
hyphen is a path separator in a unit name. Both were confirmed against a real node rather than
assumed; a wrong path reads as an absent pod, and an absent pod is billed as nothing.

A failed refresh **keeps the previous map** rather than clearing it. An empty map on a transient 500
would silently bill nothing for that interval, and nothing about an empty invoice says why.

## Consequences

The agent needs `get` and `list` on pods, which it previously did not. That is a real cost, and the
RBAC file's original argument against it is kept rather than deleted: the agent runs on every node
including tenant metal, and a credential that can list pods cluster-wide is worth stealing.

Three things bound it, and one of them is honest about what it is not:

- **`get` and `list` on pods, nothing else.** No secrets, no exec, no write verb. What it leaks if
  stolen is pod metadata.
- **A projected token**, audience-bound and expiring.
- **The field selector is a courtesy, not a control.** RBAC cannot express "only pods on your own
  node". Saying otherwise would be the same comfortable inaccuracy this ADR replaces.

The pod-resources socket stays mounted, unread, for the day a kubelet exposes labels through it.

## Alternatives considered

**The kubelet's own `/pods` endpoint**, which is node-local by construction and would need no
cluster-wide permission. It requires `nodes/proxy`, which is a _stronger_ permission than `list pods`
and grants considerably more than reading metadata.

**A watch instead of a list.** Fewer requests and lower latency, and more state to get wrong —
resource versions, re-list on 410, reconnect backoff. Worth doing when node counts make the list
expensive; at thirty seconds per node it is not close.

**Have the control plane push attribution down.** Inverts the dependency and means the meter stops
being able to attribute anything whenever the control plane is unreachable, which is exactly when
usage still needs recording.
