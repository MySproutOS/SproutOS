# 0026 — Compressed model streams were free

Real Claude Code turns succeeded through the production LLM proxy, but ClickHouse contained no new
AI-token events. Sandbox duration continued arriving every minute, proving Kafka, ClickHouse, and
the organization attribution were live. The LLM proxy's durable spool was empty and its journal
contained no delivery error, so the loss occurred before an event was created.

The proxy forwarded Claude Code's `Accept-Encoding` header while its reqwest build had no response
decompression feature. The model bytes could therefore remain compressed while passing through to
Claude Code, which decoded them at the far end. The proxy's usage accumulator tried to parse those
compressed bytes as SSE, observed no `usage` object, and intentionally emitted no empty batch. The
turn worked and its tokens were free.

This diagnosis follows from the production boundaries above and is verified by the regression
test: reqwest now receives a genuinely gzip-compressed Anthropic-shaped response, removes the
encoding after decoding, and the accumulator reads both input and output counts. Final production
verification still requires a real Claude turn followed by a newer ClickHouse AI-token row.

## Why the previous checks passed

Every proxy fixture returned identity-encoded text. The end-to-end test split an Anthropic-shaped
stream across reads and proved abandoned-client draining, but no provider in the test suite honored
`Accept-Encoding`. Claude Code could decode the relayed stream, so a successful model response did
not reveal that the observer in the middle saw different bytes.

This is the same external-evidence rule in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: a correct client-visible answer
does not prove the billing side effect. It also extends the real-provider gap tracked by
`/Users/andrew/.claude/plans/double-sorted-meteor.md` and `private_notes/sandbox-handoff.md`; a stub
that never compresses cannot prove production metering.

## What stops it coming back

The proxy now terminates `Accept-Encoding` instead of forwarding the harness's choices. Its
reqwest client advertises gzip, decodes the provider response before the stream reaches the usage
accumulator, and forwards the decoded bytes to the harness. A regression test uses a real gzip
body and asserts the encoding header is gone and both token fields are counted.

This is not a domain restriction and does not change sandbox egress. It is content negotiation on
the separate model-provider connection owned by the LLM proxy.
