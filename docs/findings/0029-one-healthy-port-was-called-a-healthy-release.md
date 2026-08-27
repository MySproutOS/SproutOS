# 0029 — One healthy port was called a healthy release

The production deploy filled an idle router colour and declared it ready after checking only the
router's primary HTTP target group. The same instance also serves the LLM proxy, OpenSearch,
Postgres, Valkey, and the sandbox forward proxy. Any of those listeners could be absent or failing
while the release passed its fill gate and moved into production.

This was not hypothetical. After a router cutover, `llm.sproutos.me` returned 503 because model
traffic still named the drained colour. Fixing that rule movement closed the immediate outage, but
the next release still would not have proved that port 8788 was healthy before moving model traffic
to it. The load balancer's primary router health check cannot establish that fact.

## Why the previous checks passed

`fill-idle.sh` already had the right aggregation: it took the minimum healthy count across every
target group in its wait set. For website releases the set contained both web and API. For router
releases it contained only the primary router group, even though `cutover.sh` moved every configured
router endpoint as one release.

The tests covered cutover after the fill, not the fill itself. They proved that LLM, search,
Postgres, Valkey, and egress moved to the same colour, but no test proved those target groups were
healthy before the move.

This is the deployed-versus-described boundary carried through the two legacy plans:
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` uses a real deployment as the
forcing function rather than treating implemented features as operational proof, while
`/Users/andrew/.claude/plans/double-sorted-meteor.md` repeatedly identifies the router as the
deployed surface for its protocol splits. `private_notes/sandbox-handoff.md` records the same lesson
more directly: the LLM proxy had code and tests before it had a production target group, and its
OpenTofu configuration had only been validated, not applied. A green check on one layer never
proved the next layer existed or answered.

## What stops it coming back

For a router release, `fill-idle.sh` now builds its health set from the same configured endpoint
variables as `cutover.sh`. The idle colour must have the desired number of healthy targets in the
router, LLM, search, Postgres, Valkey, and sandbox-egress groups that exist in that estate. An
unconfigured optional split is omitted; a configured split with zero healthy targets fails the
fill and leaves traffic where it was.

A stubbed AWS regression drives all six groups, proves a healthy primary cannot hide an unhealthy
LLM target, proves absent optional services stay optional, and preserves the website-plus-API
contract. CI runs that test before the cutover suite.
