# The router could not hairpin through its public Postgres balancer

## What was wrong

The sandbox's local database bridge successfully sent an authenticated CONNECT to the SproutOS
forward proxy. The proxy then resolved `postgres.sproutos.me` to the public Network Load Balancer
and tried to reach port 5432 from the same router instance that serves the balancer's target. That
public hairpin returned `502 Bad Gateway`. From inside Daytona it looked subtler: the loopback bridge
accepted a client, then closed as soon as the client sent a Postgres SSLRequest or startup packet.

Direct Postgres TLS from outside AWS was healthy on both NLB addresses. The failure was the path
from the router, through its own public NLB, and back to that router—not pg-proxy or Neon.

## Why the earlier checks passed

The local ngrok harness proved that the forward proxy admitted CONNECT on port 5432, but stopped at
the HTTP 200 response. It never sent Postgres protocol bytes through the resulting tunnel. A direct
TCP health check also proved that the NLB accepted connections from the internet, which says nothing
about hairpinning from its own target.

The failure was observed by the signed-in production Chrome acceptance turn required by
`private_notes/sandbox-handoff.md`, the grouping requirements in `private_notes/groups.md`, and the
legacy plans `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.

## What stops it recurring

- The forward proxy has one boot-configured exact-authority override: the platform's public
  Postgres host and port route to pg-proxy's loopback listener in the same router process.
- The override key is normalized for DNS case and a trailing dot, but it cannot be selected by an
  arbitrary sandbox hostname. Every other destination still resolves normally and is rejected if
  any answer is private, loopback, link-local, or metadata space.
- Router startup requires the public Postgres host and port when egress is enabled and derives the
  loopback target from `PG_PROXY_LISTEN`; a missing or malformed production seam is fatal at boot.
- A Rust test sends bytes through the exact override and asserts that the dialer used loopback, while
  the existing tests keep proving ordinary public resolution and private-address denial.
- Production acceptance requires `SELECT 1` and schema enumeration, not merely a CONNECT 200.
