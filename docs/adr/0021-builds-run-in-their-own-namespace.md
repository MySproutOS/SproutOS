# 0021. Builds run in their own namespace, not the tenant's

- Status: Accepted
- Date: 2026-08-20

## Context

Turning a customer's repository into an image means running a build, and a build is customer code:
every `RUN` line in a Dockerfile is arbitrary code the platform has agreed to execute.

It also needs a credential that can **push** to the registry.

Those two facts cannot both live in a tenant namespace. A pod that can push images is a pod that can
replace another tenant's image, and a tenant namespace is by definition where untrusted code is
assumed to be. Putting the build there means the blast radius of one malicious Dockerfile is every
image on the platform.

This is the same tension the agent runner already resolved: [the fork-upkeep agent is never given a
push credential](../../lib/typescript/jobs/README.md), which is why a conflicted fork raises a
suggestion rather than opening a pull request.

## Decision

Builds run in `sproutos-builds`, a namespace the platform controls, with:

- **Rootless BuildKit**, which builds inside its own user namespace.
- **`privileged` Pod Security**, because rootless BuildKit needs `seccompProfile: Unconfined` and an
  unconfined AppArmor profile to create that namespace. The exemption is scoped to this namespace and
  covers builds and nothing else.
- **Its own egress policy**: DNS, the registry named explicitly, and the internet minus every private
  range — including `169.254.0.0/16`, which is where the cloud metadata service hands out the node's
  IAM role.
- **No ingress rule at all.** Nothing should ever connect _to_ a build.

`backoffLimit: 0` and an `activeDeadlineSeconds`. A build that failed fails the same way again, and
each attempt is minutes of billed compute; retrying is the queue's decision, where there is a policy
about how many times.

## Consequences

The tenant namespace never holds a push credential. The narrow one that exists lives in a namespace
running no customer _services_ — only their build, briefly, under a rootless daemon.

`privileged` on any namespace deserves scrutiny. Isolating it here means that scrutiny has one place
to look, rather than being an argument about whether tenant namespaces should be loosened.

## Alternatives considered

**Build in the tenant namespace with a scoped push credential.** A per-tenant registry credential
limits the damage to that tenant's own images, which is better than nothing and still hands a push
credential to a pod running arbitrary customer code.

**Build outside Kubernetes entirely** — a hosted build service. Removes the isolation problem by
making it somebody else's, and adds a hard dependency on a service the platform does not control for
the operation most central to it.

**Kaniko instead of BuildKit.** Comparable isolation properties. BuildKit was chosen because
`deployment_build.builder` already defaulted to `buildkit` and because its git frontend fetches the
context itself, so the credential never touches a filesystem the build can read afterwards.
