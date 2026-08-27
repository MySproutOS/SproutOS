# 0049 — Sandbox egress crossed AWS twice and billed nobody

The Daytona sandbox was correctly created with the platform's authenticated `outboundProxyUrl`.
That made the Rust forward proxy the mandatory HTTP(S) boundary, but the proxy discarded the
`SandboxAuthorization` after it had proved the sandbox, organization, project and live lifecycle
state. It copied bytes in both directions and emitted no usage.

This was a billing hole, not a Daytona fee. Daytona does not list a network-transfer line item. The
proxy runs on AWS, however, and a public exchange has two data-transfer-out legs from that account:

1. the sanitized HTTP request, or the client side of a CONNECT tunnel, leaves the proxy for the
   public destination; and
2. the public response enters the proxy and then leaves it again for the Daytona sandbox.

The meter therefore records `sandbox_egress_byte` as the sum of bytes successfully written on both
AWS-outbound legs. For plain HTTP this includes only the rewritten request actually forwarded — not
the incoming `Proxy-Authorization` header — plus the response bytes. For CONNECT it includes the
eager buffered ClientHello, later client-to-upstream tunnel bytes, and upstream-to-client tunnel
bytes. The proxy's own `200 Connection Established` is not upstream data. TCP/IP and TLS-record
overhead outside the proxy's byte streams is not observable here and is not guessed.

The boot-configured Postgres hairpin override has one exception: request bytes written to loopback
do not leave AWS, while response bytes sent back to Daytona still do. The meter preserves partial
counts when a peer disconnects because it counts successful writes, not only a successful final
`copy` result.

Each completed connection becomes one HMAC-signed event carrying the authorization's organization
and project through the same fsynced spool and retry delivery used by the other Rust meters. A
configured forward proxy now refuses to start without that ingest key and endpoint, so a missing
billing path cannot look like a healthy egress boundary. It also reserves worst-case spool capacity
before dialing a public destination and returns 503 if no capacity remains; a full billing queue is
backpressure, not permission to create unrecorded transfer.

One bounded reconciliation gap remains: counters live in memory until a connection closes. A hard
router-process or host failure during a CONNECT tunnel can therefore lose the bytes written by that
in-flight connection even though capacity was reserved. Tunnels are capped at five minutes, which
bounds but does not eliminate the exposure. Exact crash recovery would require periodic idempotent
delta checkpoints or reconciliation against AWS flow/CUR data; inventing either without a stable
connection-level provider record would make the ledger look more exact than its source.

The [public US-East EC2 first-tier rate](https://aws.amazon.com/ec2/pricing/on-demand/) is $0.09 per
GB. The [AWS glossary](https://docs.aws.amazon.com/glossary/latest/reference/glos-chap.html) defines
GB as 1,000,000,000 bytes, making the pass-through rate `0.00009` micro-USD per byte with zero
SproutOS fee. As with Daytona's free disk allowance and Neon's included allowances, account-level
promotions and aggregate free tiers are not assigned to an arbitrary tenant; published marginal
provider unit rates are. The tenant NLB also has an
[NLCU charge](https://aws.amazon.com/elasticloadbalancing/pricing/) based on the highest of new
connections, active connections or processed bytes for the hour, rather than an additive per-byte
line for this sandbox. This repository enables cross-zone balancing, which can add regional
transfer only when the selected NLB node and target are in different AZs. Neither cost is uniquely
attributable from one proxy connection. They remain unallocated platform infrastructure unless CUR
reconciliation produces a reliable marginal unit price; they are not guessed into this dimension.

Daytona's [network-limit documentation](https://www.daytona.io/docs/en/network-limits/) is the
routing basis: `outboundProxyUrl` chains HTTP(S) through the configured upstream, and clients that
ignore the proxy variables are blocked at egress. That is why this remains an unrestricted-public-
internet design without `domainAllowList` or `networkAllowList`, while direct HTTP(S) bypass is not
an alternate unmetered path.

This finding follows the legacy launch plan
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, the proxy and durable-metering
requirements in `/Users/andrew/.claude/plans/double-sorted-meteor.md`, and the implementation record
in `private_notes/groups.md` and `private_notes/sandbox-handoff.md`. In particular, the handoff's
earlier four-constraint failure is why the dimension contract, downstream checks and active price
must land together rather than treating a new string as a local proxy change.

The regression tests prove exact request/response counts for plain HTTP, both CONNECT directions,
the loopback exception, and organization/project attribution in the signed event batch.
