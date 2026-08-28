# 0064: The DNS challenge was hashed twice

## What was wrong

`acme-client` passes `challengeCreateFn` the final DNS-01 value: the SHA-256 digest of the ACME key
authorization, encoded as base64url. The platform certificate worker treated that value as the
preimage and hashed it again before writing Route 53.

The worker therefore waited for a healthy `INSYNC` change containing value B while `acme-client`
looked for value A. Production retries failed with `Authorization not found in DNS TXT record` and
then removed B in their cleanup callback, so inspecting Route 53 after the error showed no stale
record and made the failure look like propagation alone.

The live retry removed that ambiguity. At 09:14 UTC the TXT value was simultaneously visible from
all four Route 53 authorities, Google Public DNS, and Cloudflare's resolver while the running worker
still could not verify the challenge. Propagation of the value we wrote was healthy; it was simply
not the value `acme-client` was looking for.

There was a second timing gap: `GetChange=INSYNC` describes Route 53's change, but the next line let
`acme-client` query a recursive resolver immediately. No check proved that the expected value was
visible through that public path or directly from every authoritative nameserver.

## Why the existing checks passed

The unit test passed a made-up `token.key-authorization` preimage to `putDnsChallenge` and expected
its hash. That was internally consistent with our helper but not with the callback contract of the
library that calls it. The Route 53 mock stopped at `INSYNC`, so no DNS answer ever had to contain
the value the ACME client would verify.

Cleanup removed only the current callback's known value, which is correct during a live process.
It could not remove an older value left by a crash between creation and callback cleanup. Each retry
preserved every prior value and could grow the shared apex/wildcard RRset indefinitely.

## What stops it recurring

- `putDnsChallenge` writes the callback's DNS-01 digest unchanged, and its test supplies a real
  digest-shaped value and asserts byte-for-byte preservation.
- After Route 53 reports `INSYNC`, the worker requires the value from the public resolver path and
  directly from every authoritative nameserver before returning control to `acme-client`.
- The first write to each challenge RRset in a new platform order replaces stale values. Later
  writes in the same order still merge values, which preserves the simultaneous tenant apex and
  wildcard authorizations that intentionally share one record.
- Tests cover public propagation delay, authoritative visibility, and first-write stale cleanup.
