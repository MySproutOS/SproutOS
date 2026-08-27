# Daytona's essential services bypassed the proxy

**Found by:** unsetting every standard proxy variable inside a running production Daytona sandbox
and requesting destinations from Daytona's essential-services list.

## What looked true

The sandbox was created with an authenticated `outboundProxyUrl`. A request to an arbitrary public
site succeeded through SproutOS, the same request failed when its client explicitly bypassed the
proxy, and a metadata request was refused. The injected agent skill consequently said direct egress
was blocked.

That statement was broader than the evidence. It described one arbitrary site as though it proved
the provider's entire outbound policy.

## What was actually true

On 2026-08-27 the production sandbox returned `200` directly from GitHub, the npm registry, and
PyPI after `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and their lowercase forms were removed. A
direct Anthropic request also connected and returned the provider's ordinary unauthenticated `404`.
The same direct request to `example.com` was reset.

This is Daytona's documented Tier 1/2 behavior: the organization policy blocks arbitrary internet
destinations but keeps its essential-services catalog reachable. The current organization rejected
an attempted sandbox `networkAllowList` update with `400` and said the tier's network policy could
not be overridden.

The SproutOS proxy itself behaved correctly:

- proxied `https://example.com` returned `200`;
- direct `https://example.com` was reset;
- proxied `http://169.254.169.254/latest/meta-data/` returned `403`;
- Daytona reported an authenticated `outboundProxyUrl`, with no domain or CIDR allowlist.

## What stops the instruction being wrong

The sandbox skill now gives the operational rule rather than claiming a provider boundary that is
not present: every public HTTP(S) destination is available through SproutOS; agents must retain the
proxy variables; and tools that ignore them must be configured to use the existing proxy. Private,
loopback, link-local, and metadata rejection is attributed specifically to the SproutOS proxy.

This is an instruction boundary, not enforcement against hostile sandbox code. Strict proxy-only
egress requires Daytona to remove the essential-services exception for this organization. Current
Daytona documentation says that means either a Tier 3/4 sandbox policy or an organization-policy
adjustment by Daytona support. If that policy changes, acceptance must re-run both arbitrary-domain
and direct essential-service probes; the presence of `outboundProxyUrl` alone is not proof.

## Historical context

This finding refines [ADR 0030](../adr/0030-daytona-egress-uses-the-platform-proxy.md) and retains the
same legacy chain: `private_notes/groups.md`, `private_notes/sandbox-handoff.md`,
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
