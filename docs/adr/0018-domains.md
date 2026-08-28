# 0018. `sproutos.dev` is the control plane; `sproutos.run` is tenant traffic

- Status: Accepted
- Date: 2026-08-20

## Context

Four areas named three apex domains, and two of them disagreed about preview host format.

The auth notes set the session cookie on `.sproutos.dev`. The OAuth-provider notes make the issuer
`https://sproutos.dev`. The infra notes provision a wildcard ACM certificate for
`*.<env>.**sproutos.app**`. The compute notes set `PROD_DOMAIN` to `**sproutos.run**` with previews at
`pr-<n>--<slug>.sproutos.run`.

On preview host format, compute is emphatic: "**An ACM wildcard covers exactly one label**, so
preview hosts must never contain a second dot" — hence the double-dash separator. The infra notes
write `pr-42-myapp.sproutos.app`, single-dash, which happens to satisfy the same constraint but by
accident rather than convention.

There is also a security reason to separate the domains that no area stated: tenant code runs on
tenant hostnames. If tenant sites are served from a subdomain of the control-plane apex, a tenant
can set cookies on the parent domain, and our `Domain=.sproutos.dev` session cookie is sent to
tenant-controlled hosts.

## Decision

Two registrable domains, carried as OpenTofu variables, never hardcoded:

- **`sproutos.dev`** — the control plane. Marketing site, dashboard, admin, the API, the OAuth
  issuer, the session cookie's `Domain=.sproutos.dev`.
- **`sproutos.run`** — everything a tenant controls. Production sites, PR previews
  (`pr-42--myapp.sproutos.run`), dev sandboxes (`<sandbox-id>.dev.sproutos.run`).

`sproutos.app` is dropped entirely.

## Consequences

- **The session cookie never reaches tenant code.** This is the main reason for the split, and it
  means a tenant site cannot read or set anything on the control-plane domain.
- Preview and sandbox hosts are single-label under their wildcard: `pr-42--myapp.sproutos.run` uses
  the double-dash separator, matching Knative's tag convention. `pr-42.myapp.sproutos.run` would need
  a second wildcard certificate per project, which is not a thing we can issue.
- Two ACM certificates: `*.sproutos.dev` (+ apex SAN) and `*.sproutos.run` (+ `*.dev.sproutos.run` for
  sandboxes, since a wildcard covers exactly one label).
- Two Route53 hosted zones, two sets of DNS records, and `external-dns` scoped per zone.
- Local development uses `localhost:3000/3001/3002/3003` and derives an undefined cookie domain, so
  the split costs nothing in dev.
- Custom tenant domains, when they land, are CNAMEs onto the `sproutos.run` ingress — and will hit the
  ALB's 25-certificates-per-listener soft limit, so SNI via CloudFront or a limit increase is a known
  future task.
- Both names appear in the plan's `.template.env` and in `tofu/variables.tf` as
  `control_plane_domain` and `tenant_domain`.

## Alternatives considered

**One apex with a tenant subdomain** (`*.tenants.sproutos.dev`). One certificate, one zone. Rejected
on the cookie-scope hazard above — it is a same-site relationship between our session and arbitrary
customer code.

**`sproutos.app` for tenants** (the infra design). Functionally equivalent to `sproutos.run`.
Rejected because `sproutos.run` is the registered tenant domain and keeps the product identity in
the hostname.
