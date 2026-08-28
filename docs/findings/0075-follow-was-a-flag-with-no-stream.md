# Follow was a flag with no stream

**Found:** 2026-08-28, while reconciling the canonical CLI command list with the App Store launch
plan.

## What looked true

`sprout logs` accepted `--follow`, authentication already requested `observability:logs:read`, and
the API already exposed a project-scoped log query. The command therefore appeared complete in
help and parsing tests.

## What was actually true

The runtime branch returned `Unavailable` before making a request. More importantly, repeatedly
calling the existing newest-first page would not have been a safe implementation: a burst larger
than one page could push unseen older rows out of the next response, while a timestamp-only cursor
cannot distinguish records Lambda emits in the same millisecond.

## What stops this instance recurring

The API now has a hidden, authenticated SSE endpoint backed by a separate arrival-ordered
ClickHouse query. Its v1 cursor combines Kafka's partition/offset arrival sequence with an ingest
key stamped before Kafka. Projects are keyed to one partition, so this preserves late records whose
Lambda timestamp is older than the current display and collapses an exact Kafka replay. Full pages
drain without sleeping. The SSE `id` returns as both the opaque query cursor and `Last-Event-ID`;
the server rejects a disagreement instead of guessing which checkpoint is authoritative.

The CLI accepts only version-1 `log` events whose body cursor matches the SSE id, writes one
complete success envelope per line in `--json` mode, and advances its checkpoint only after stdout
accepts that line. Reconnect delay, event size, HTTP error body size, and consecutive transport
failures are bounded. Cursor state advances immediately after each flushed line, including when
the next network read fails. First-byte, whole-read and idle waits are bounded, as are the server's
ClickHouse and backpressure waits. Authorization remains a header, never a cursor or query
credential. Transport diagnostics never render reqwest's request-aware error because it contains
the complete URL and therefore private search filters and resume state; they also never render
headers or the bearer value. The server's best-effort terminal error frame uses the connection
abort signal too, so a non-reading downstream cannot hold the handler after its deadline. Messages
are capped at 64 KiB on ingest so even worst-case JSON escaping fits the CLI's 512 KiB event bound.

Tests now fail if follow returns through the buffered adapter, if the JSONL shape changes, if a
resume id is malformed, or if a reconnect omits the last accepted cursor.
