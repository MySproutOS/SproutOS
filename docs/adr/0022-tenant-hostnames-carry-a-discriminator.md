# 0022. Tenant hostnames carry a project discriminator

- Status: Accepted
- Date: 2026-08-20
- Amends: [0018](0018-domains.md)

## Context

[ADR 0018](0018-domains.md) fixed the preview host format as `pr-42--myapp.sprout.run`, with the
double-dash separator chosen because **an ACM wildcard covers exactly one label**.

That constraint has a consequence 0018 did not follow through. Because the host may contain only one
label before the apex, Knative's domain template has to be `{{.Name}}.{{.Domain}}` — the namespace
cannot appear in it. So the Knative Service name **is** the entire hostname, and it must therefore be
globally unique.

`project.slug` is not globally unique. `project_org_slug_live_key` makes it unique _per
organization_, which is the right product behaviour: a customer naming their project `myapp` should
not be told the name is taken by a stranger.

Two organizations each with a project called `myapp` would be issued the same hostname, and the
second to deploy would take over the first one's traffic. `pr-42--myapp` has exactly the same
collision.

## Decision

The host label is the project slug plus six characters of the project's id:

- production: `myapp-abdf5a.sprout.run`
- preview: `pr-42--myapp-abdf5a.sprout.run`

The discriminator is the **tail** of the UUIDv7, which is its random part; the head is a millisecond
timestamp and two projects created in the same tick would share it.

When the label must be truncated to fit 63 characters, the **slug** is trimmed — never the
discriminator and never the `pr-N--` prefix. Losing the discriminator loses uniqueness; losing the
prefix points a preview at production.

The `--` separator is kept exactly as 0018 specifies.

## Consequences

Tenant URLs are slightly uglier than `myapp.sprout.run`. This is the cost of per-organization slug
uniqueness, and it is paid in a string most customers will replace with a custom domain.

`hostLabel` is a pure function with tests, including one asserting that two projects sharing a slug
receive different hosts. Removing the discriminator fails three of them.

## Alternatives considered

**Make project slugs globally unique.** Removes the discriminator and produces the nicer URL. It is a
product change, not a technical one: it means telling a customer their project name is unavailable
because someone they have never heard of used it first. **This remains open for the product owner to
overrule** — the change is confined to `hostLabel` and the slug allocator.

**Put the organization in the label** — `myapp--acme.sprout.run`. Reads better than a hex fragment
and collides again the moment an organization is renamed, since the hostname would have to change
with it.

**A wildcard certificate per project.** Removes the one-label constraint entirely and requires
issuing and renewing a certificate per project, which is the operational burden 0018 rejected.
