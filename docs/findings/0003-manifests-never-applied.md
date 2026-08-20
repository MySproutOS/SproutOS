# 0003. Manifests that had never met an API server

`deploy/` was schema-valid, reviewed, and had never been applied to anything. Applying it to a real
cluster for the first time produced four failures at once, none of which a schema check can find —
because each one is perfectly valid YAML.

## Nothing created the namespaces

Every document targets a namespace. `sproutos-system` was declared as the **second document inside
`metering/rbac.yaml`**, which sorts after the DaemonSet that lives in it; `external-secrets` and the
tenant namespace were never declared at all.

A fresh apply failed on its first document with `namespaces "sproutos-system" not found`,
twenty-five times over. `kubectl apply` processes a multi-document stream in order, and the renderer
concatenates files in sorted path order — so a Namespace declared anywhere else is a Namespace
declared _after_ something that needs it.

Now `deploy/00-namespaces.yaml`, which sorts and applies first.

## The metering DaemonSet could never create a pod

It reads cgroup v2 through `hostPath`, which is forbidden under the `restricted` Pod Security
Standard **and** under `baseline`. `sproutos-system` enforces `restricted` — and its own comment
claimed the agent complied.

Desired 1, current 0, silently, because **a DaemonSet that creates no pods is not an error condition
anywhere except in its own event log.** It now has its own `privileged` namespace, so the other six
workloads keep enforcing `restricted`. Widening `sproutos-system` would have been one line and would
have dropped the guarantee for all of them.

## `valkey-proxy` could not start with a hostname

It parsed its backend into a Rust `SocketAddr`, which accepts only a literal IP. Production hands it
an ElastiCache endpoint — a DNS name — so it would have crash-looped on `invalid socket address
syntax` forever.

**Every test passed**, because the test configuration is `127.0.0.1:41023`. It now takes a string and
resolves per connection, which also survives a failover that moves the endpoint; a `SocketAddr`
resolved at boot pins one IP for the life of the process.

## Every External Secrets resource was rejected

They declared `external-secrets.io/v1beta1`. Current External Secrets serves `v1` and marks
`v1beta1` `served: false` — six flat rejections, and the whole secrets layer dead on arrival, which
means every workload sitting in `CreateContainerConfigError` indefinitely.

See [0001](0001-checks-that-do-not-check.md) for why the schema validation could not catch this.

## A readiness probe pointed at a route that did not exist

`/health` returned 404. Every API pod would have failed readiness forever and never joined the
Service.

Adding it exposed a second one: the probe's default `timeoutSeconds` is **1**, while the handler's
own database check takes up to **2** seconds. Whichever is shorter decides, and it should be the one
that can explain itself — a bare kubelet timeout says nothing, while the handler's 503 names the
reason.

## The probes are split deliberately

`/health` checks nothing but the process; `/ready` checks Postgres. A liveness probe that checked the
database would restart every API pod during a database blip and crash-loop the fleet through its own
recovery. Readiness only removes a pod from rotation, which reverses itself.

## Also confirmed by something failing

A stock `postgres:18-alpine` was rejected outright by the `restricted` standard on `sproutos-system`.
That is the evidence that the six SproutOS workloads satisfying it are satisfying something real,
rather than the label being decorative.
