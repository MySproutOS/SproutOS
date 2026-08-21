# 0009 — Somewhere to run untrusted code

`action.http` and `action.code` were refused outright, and finding 0007 recorded why: the only place
to run them was the job worker, which holds the control-plane database URL, the envelope KMS key,
the GitHub App credentials and a Kubernetes service-account token. Fetching a URL a customer typed
from there reaches the API server, every tenant's database, and `169.254.169.254`.

Refusing was correct and it is not a finished feature. This is the sandbox that replaces it, and the
six defects found on the way to running one line of customer code.

---

## What the boundary is, and what it is not

A Job in the **tenant's own namespace**, where `deploy/tenant/network-policy.yaml` is already in
force: default-deny both directions, egress to DNS, to the three data-plane proxies, and to
`0.0.0.0/0` _minus_ 10/8, 172.16/12, 192.168/16 and 169.254/16. No service-account token, no root,
no capabilities, a read-only root filesystem, CPU _and_ memory limits, and a deadline Kubernetes
enforces rather than one a caller has to remember.

`runtimeClassName` is **optional**. On a cluster with a bare-metal pool and `kata-deploy` it is
`kata-fc` and there is a VM under the pod. The trial cluster has neither, so there is not — the
isolation is a namespace and a policy. That is a real reduction and it is stated rather than
implied, because the alternative actually shipping was running this code in the control plane's own
pod.

### Verified, on the live cluster

A legitimate fetch:

```
action.http   succeeded  exit=0
  out: "<!doctype html><html lang=\"en\"><head><title>Example Domain</title>…"
action.code   succeeded  exit=0
  out: "{\"sum\":4,\"at\":1}\n"
```

And the same node pointed at the instance metadata service — the endpoint that hands out the
node's own credentials:

```
action.http   failed  exit=28
  out: "curl: (28) Connection timed out after 30002 milliseconds\n"
```

Timed out, at the NetworkPolicy, with the reason recorded on the step and the run marked failed.

---

## The six on the way

**1. There were no Roles.** `deploy/platform/rbac.yaml` contained ServiceAccounts and nothing else.
A ServiceAccount with no binding can do nothing, so every Job the worker exists to create — the
image builds, the Knative deploys, and now the sandboxes — would have been refused. The grant is
narrow, and deliberately excludes secrets, configmaps and everything in `rbac.authorization.k8s.io`:
a worker that could read Secrets cluster-wide could read every tenant's database password.

**2. `create` is not `patch`.** Server-side apply is a PATCH with
`application/apply-patch+yaml`, which the API server authorizes as `patch`. The grant listed
`create` and looked complete.

**3. The kube client read the cluster CA and never used it.** `inClusterConfig` has always parsed
`ca.crt` into `certificateAuthority`; `createKubeClient` ignored it, so every call from inside a pod
failed `unable to verify the first certificate`. Nothing had noticed because nothing had ever called
it from a pod — the deploy and build handlers had no RBAC to get that far.

Fixed with `node:https` rather than `fetch`, because Node exposes no supported way to give `fetch` a
CA: its undici is bundled and unexported, and `NODE_EXTRA_CA_CERTS` is process-global — the
cluster's CA has no business vouching for github.com.

**4. The step carried none of the node's configuration.** `stepRowsFor` wrote `input: {}`, so a
sandboxed `action.http` was handed nothing and failed "needs a url" for a node whose graph had one.

**5. The `/log` subresource refuses to be asked for the type it returns.** It sends plain text and
answers `Accept: text/plain` with a 406, negotiating against the standard resource list — json,
yaml, protobuf — none of which is what it sends.

**6. A step could fail while the run reported success.** The step recorded `failed`; nothing made
the run agree.

---

## Two I did to myself, and what they cost

**The fix that did not apply.** The CA change converted `request` and left `logs` on global `fetch`:
the formatter reflowed those lines between the patch being written and applied, the replacement
matched nothing, and nothing said so. The client authenticated fine and then failed on the one call
that reads a sandbox's output.

There is a test now — `kube.test.ts` asserts against the source that no code path calls `fetch` —
because the property is about a branch that was not taken, and no runtime observation covers one of
those.

**The comment that ended itself.** Documenting `Accept: */*` inside a `/* … */` block closed the
comment on the header's own value and commented out the rest of the function. Lint went from 0
errors to 107 and 22 test files failed.

It was caught because the image build runs lint and tests first — the same "make the check
non-optional" property that `bin/check-images.sh` was written for one finding earlier, and that I
then skipped and immediately regretted. The pattern holds: a check you have to remember is a check
that gets skipped, including by the person who wrote it.
