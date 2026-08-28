# Dual-stack erased the client address

## What was wrong

The planned tenant edge enabled `preserve_client_ip` on an IPv4 instance target group and treated
that as evidence that both IPv4 and IPv6 viewers would reach Rust with an authoritative socket peer.

That is not how an AWS dual-stack Network Load Balancer crosses address families. An IPv6 viewer is
translated to the IPv4 target, and AWS documents that the target receives the load balancer's IPv4
address. Client-IP preservation has no effect on that translation. Enabling AAAA as written would
therefore have made Lambda `requestContext.http.sourceIp` correct for IPv4 visitors and silently
wrong for IPv6 visitors.

## Why the checks would have passed

Every local edge test connects directly to Rust, so `TcpStream::peer_addr()` is the test client.
OpenTofu validation checks the resource schema, not whether an address survives the NLB's frontend
to target translation. An IPv4-only production smoke would also have passed.

The generic `/healthz` probe compounded it: it did not traverse the TLS or HTTP edge port and could
remain green after either listener task stopped.

## What stops it recurring

The web edge is a separate dual-stack NLB, leaving the live Postgres/Valkey NLB in place. Only its
HTTP and TLS target groups enable Proxy Protocol v2. One bounded stream parser runs before TLS,
plain HTTP, and the dedicated readiness listener; tests cover IPv4, IPv6, LOCAL, fragmented and
coalesced input, malformed and missing headers, and oversized payloads. The router constructs trusted
forwarding metadata from the Proxy Protocol source rather than the translated socket peer.

The edge target groups probe distinct `/ready/http` and `/ready/tls` paths. Those flags belong to the
listener tasks, so a stopped listener is no longer hidden by the unrelated router health endpoint.

Proxy Protocol remains disabled on Postgres, Valkey, legacy egress, and the ordinary router health
listener. Expanding it is a separate wire-protocol migration, not a reusable load-balancer toggle.
