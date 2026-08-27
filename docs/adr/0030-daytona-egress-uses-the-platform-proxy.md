# 0030. Daytona sandbox HTTP egress uses the platform proxy

- Status: Accepted; implementation and production verification pending
- Date: 2026-08-26
- Extends: [0026](0026-aws-only-lambda-and-two-rust-proxies.md)

## Context

Coding agents must be able to install arbitrary dependencies and call arbitrary public APIs. A
fixed domain list is not the product: a valid customer program cannot depend on whether SproutOS
predicted every package host and third-party service it would use.

Daytona gives Tier 1 and Tier 2 organizations a provider-wide restricted network policy. That
policy cannot be loosened with a sandbox domain or CIDR allowlist; unrestricted direct egress is a
Tier 3 feature. Daytona also supports a create-time `outboundProxyUrl`: its egress proxy sets the
sandbox's HTTP proxy variables and chains HTTP and HTTPS requests to an upstream proxy we control.
Daytona's current network-limits documentation says clients that ignore those variables are blocked
at egress. The installed 0.207.0 SDK's older JSDoc calls it convenience routing instead, so the live
test deliberately bypasses proxy variables and treats a successful direct request as a failure.
The URL may be HTTPS and carry credentials. It cannot be changed after sandbox creation.

On 2026-08-26 a disposable sandbox on the current restricted organization was created with
`outboundProxyUrl=https://sproutos.me`. Daytona injected its internal `HTTP_PROXY` and
`HTTPS_PROXY`, and `curl https://example.com` issued `CONNECT example.com:443` through that chain.
The request received 502 because `sproutos.me` is an ordinary website, not a forward proxy. The
sandbox was deleted with provider confirmation. This proves that the restricted organization can
reach a configured upstream and attempt an arbitrary CONNECT destination; a real authenticated
proxy still needs the full success and bypass tests below.

This decision continues, rather than replaces, the project record:

- `private_notes/groups.md` is the original hosted-Daytona, direct-preview, and in-sandbox-agent
  requirements report.
- `private_notes/sandbox-handoff.md` records the earlier Docker-only evidence and why it was not
  Daytona proof.
- [finding 0021](../findings/0021-the-interface-was-not-the-provider.md) records the first live
  Daytona corrections, including removal of the invalid domain/CIDR policy.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` remains the legacy deployment
  plan and requires browser/effect verification rather than treating an exit code as proof.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` remains the isolation and metering plan.

## Decision

Daytona sandboxes set an authenticated HTTPS `outboundProxyUrl` at creation. There is no
`EGRESS_ALLOWED_DOMAINS` setting and no SproutOS domain allowlist. Tools that honor standard proxy
configuration can reach any public destination through the platform proxy.

The forward proxy runs as another Rust listener in the existing router process and fleet. It is
exposed by a TLS listener and target group on the existing public tenant NLB. The ALB is not used:
CONNECT is a byte tunnel, while the NLB can terminate the outer TLS connection and forward the HTTP
proxy stream unchanged. This adds no new always-on compute and no second load balancer.

The proxy is not open. Each sandbox gets a deterministic credential derived with a dedicated root
key and domain-separated HMAC. The username identifies the sandbox. Every new request checks that
the sandbox, project, and organization still exist and that the sandbox is in an authorized live
state. CONNECT tunnels have a five-minute total lifetime, so stopping or deleting a sandbox rejects
new connections immediately and bounds an already-open tunnel even though Daytona's create-only
proxy URL cannot rotate.

The proxy supports HTTP absolute-form requests and HTTPS CONNECT. It removes proxy and hop-by-hop
credentials before forwarding and never logs headers, bodies, URL paths, or query strings. It
resolves destinations itself, rejects the request if any answer is non-public, and connects to the
validated address. Loopback, private, link-local, carrier-grade NAT, multicast, unspecified,
reserved, IPv4-mapped private IPv6, cloud metadata, and the proxy itself are denied. CONNECT is
limited to port 443; “all domains” does not make the service an SMTP, SSH, or arbitrary-port relay.

The proxy credential is stable for the sandbox because Daytona cannot update `outboundProxyUrl`.
It is therefore inaccurate to call the bearer short-lived. Its authorization is lifecycle-bound:
the derived password is useless for another sandbox and live database state is checked throughout
use. LLM access tokens remain separate, short-lived, rotating credentials. Database credentials
remain branch-scoped because an HTTP proxy cannot protect the Postgres wire protocol.

## Verification required before production acceptance

- Missing, wrong, cross-sandbox, stopped, and deleted credentials all return the same 407 and never
  open a destination socket.
- Public HTTP and HTTPS destinations outside Daytona's essential-service list work from a sandbox
  on the current restricted organization.
- A client explicitly bypassing proxy variables remains blocked by Daytona's provider policy.
- Metadata, private DNS answers, mixed public/private DNS answers, localhost, and proxy-self
  destinations remain unreachable.
- Stopping a sandbox rejects new requests and closes an existing bounded CONNECT tunnel.
- The NLB certificate, target health, and blue/green listener movement are checked after apply.
- The sandbox is destroyed with wait confirmation after the probe, and provider inventory shows no
  leftover sandbox or snapshot created by the test.

## Consequences

- Tier 3 is no longer required merely to let HTTP-aware agent tools reach arbitrary public domains,
  if the real restricted-tier verification passes.
- Raw non-HTTP protocols are not promised. Git must use HTTPS rather than SSH; public database and
  arbitrary TCP access are outside this proxy.
- A future Daytona feature that updates outbound proxy credentials can replace lifecycle-bound
  credentials with rotating ones without changing the agent-facing network contract.
- Provider webhooks and telemetry can assist operations but do not replace SproutOS authorization,
  reconciliation, or billing records.
- `lib/typescript/jobs/src/sandbox-stop.live.test.ts` creates a real control-plane row and Daytona
  sandbox with the same UUID, then proves public HTTPS succeeds through the authenticated proxy,
  explicit `--noproxy` access fails, metadata fails, and the provider is stopped. This is the
  executable production-boundary check; a unit test of create parameters is not equivalent. It
  requires `SANDBOX_LIVE_EGRESS_CONTROL_PLANE=1`, an explicit assertion that its `DATABASE_URL` is
  the database read by the configured public proxy.

## Provider references checked against SDK 0.207.0

- [Network limits and outbound proxy](https://www.daytona.io/docs/en/network-limits/)
- [Signed preview URLs](https://www.daytona.io/docs/en/preview/)
- [Sandbox lifecycle and deletion](https://www.daytona.io/docs/en/sandboxes/)
- [Filesystem persistence](https://www.daytona.io/docs/en/persistence/)
- [Snapshot lifecycle](https://www.daytona.io/docs/snapshots/)
