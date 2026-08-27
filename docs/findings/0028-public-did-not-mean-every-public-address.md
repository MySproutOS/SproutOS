# 0028 — Public did not mean every public address

The sandbox forward proxy had the right boundary and two wrong edge definitions.

It authenticated a live sandbox before resolving anything, rejected a DNS answer if any address in
it was private, and dialled the validated address rather than resolving the hostname a second time.
But its hand-written IPv4 match treated `192.0.0.0/16` as special-purpose. IANA reserves
`192.0.0.0/24`, not the whole `/16`, and even that `/24` contains the globally reachable anycast
addresses `192.0.0.9` and `192.0.0.10`. A perfectly public dependency in the rest of that `/16`
received 403.

The IPv6 side made the opposite mistake. It admitted almost all of `2000::/3`, including
documentation, benchmarking, 6to4, and other entries whose `Globally Reachable` value in IANA's
special-purpose registry is false. Those addresses are not RFC 1918, but they are not public
destinations either. “Block private” is too narrow a rule for an SSRF boundary; the rule is “allow
only globally reachable.”

## The first answer was also treated as the domain

DNS returns an ordered set, not an availability promise. The first implementation validated every
answer and then dialled only `addresses[0]`. The next implementation looped over them, but put the
whole loop under one shared timeout. A stalled first AAAA record consumed that deadline before the
first A record was attempted. In both versions a domain with a healthy public address failed because
an earlier public address was unhealthy.

The proxy now starts connection attempts to every validated address under one shared deadline and
uses the first success. The losers are aborted when one connects or the deadline expires. It still
rejects the entire DNS result before opening any socket if even one answer is not globally
reachable, so fallback cannot become a mixed public/private rebinding path.

## Why this belongs to the sandbox handoff

`private_notes/groups.md` is the original hosted-Daytona design. The legacy deployment plan at
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` requires checking effects rather
than reading a successful exit code, and the isolation plan at
`/Users/andrew/.claude/plans/double-sorted-meteor.md` is where tenant network boundaries are made
explicit.

`private_notes/sandbox-handoff.md` records the earlier evidence problem plainly: every sandbox turn
had been exercised through the local Docker driver, not the Daytona path production uses. The
forward proxy corrected that architecture, but a green test using `1.1.1.1` proved one example, not
the words “all public domains.” This finding is the same lesson at the next boundary down.

## What stops it coming back

`public_address_policy_tracks_iana_global_reachability` carries boundary examples from IANA's IPv4
and IPv6 Special-Purpose Address Registries. It includes public exceptions inside special blocks,
ordinary public space beside a special block, metadata/link-local/private addresses, IPv4-mapped
IPv6, NAT64, documentation, benchmarking, 6to4, ORCHID and other protocol assignments. A broad
prefix shortcut now breaks a named case on the side where it is wrong.

`a_stalled_first_public_dns_answer_does_not_block_the_next` does not use a polite connection
refusal. Its first validated address never completes, while its second serves the request. A
sequential loop under one deadline therefore fails this test; only an implementation that actually
gives the later answer a chance can pass.

The registries are external state and can change. Their current sources are:

- <https://www.iana.org/assignments/iana-ipv4-special-registry/>
- <https://www.iana.org/assignments/iana-ipv6-special-registry/>

When either registry changes, the table and its boundary cases must move together.
