# Daytona did not preserve the upstream proxy URL

## What was wrong

SproutOS gives Daytona an authenticated public HTTPS proxy when it creates a sandbox. The sandbox
does not receive that URL in `HTTPS_PROXY`. Daytona terminates it in a provider-owned sidecar and
injects an unauthenticated local HTTP URL instead. The Postgres launcher accepted only the original
authenticated HTTPS shape, so a fresh production workspace failed before the model could start:

```text
SproutOS sandbox network setup failed: HTTPS_PROXY must be an authenticated HTTPS URL
```

The same live check also found that the detached tunnel inherited the command session's stderr
descriptor. A successful command could therefore leave the caller waiting for a pipe held open by
the long-lived tunnel.

## Why the earlier checks passed

The local Daytona/ngrok harness deliberately points Daytona at a test-only raw TCP endpoint and
proved the public authenticated proxy itself. The initial launcher test also exercised that direct
HTTPS origin. Neither check inspected the proxy URL Daytona actually injects after interposing its
sidecar, and the tunnel had not yet survived long enough to expose the inherited descriptor.

This is a continuation of the sandbox history in `private_notes/sandbox-handoff.md`, the grouping
requirements in `private_notes/groups.md`, and the legacy plans
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.

## What stops it recurring

- The launcher accepts both Daytona's local unauthenticated HTTP sidecar and the authenticated HTTPS
  origin used by the local harness. It still rejects every other URL scheme and partial credentials.
- CONNECT destination authorization remains in the SproutOS Rust proxy; accepting Daytona's local
  hop does not permit private, metadata, or arbitrary-port destinations.
- A unit test runs real bytes through an unauthenticated HTTP CONNECT sidecar and asserts that no
  fabricated `Proxy-Authorization` header is sent.
- The detached tunnel keeps only its bounded readiness descriptor; it does not inherit stdout or
  stderr from the agent command.
- A real production Daytona workspace was inspected without revealing its credential and then ran
  the patched launcher through the injected sidecar to the public Postgres listener.
