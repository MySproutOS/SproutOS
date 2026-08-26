# `sproutos-metering-proto`

The usage-event schema and its signature. Shared by every metering emitter — the cgroup sampler,
the valkey proxy, the pg proxy, the search proxy — and mirrored by the TypeScript ingest route that
verifies what they send.

## Money must never ride a lossy path

A usage event is a line on an invoice. That makes it structurally different from a metric, and it
has to be treated differently at every step:

- **Not telemetry.** Telemetry pipelines are allowed to sample, coalesce, drop under backpressure
  and expire buffers. Every one of those behaviours silently changes a bill. Usage events go over
  their own path, with delivery acknowledged by the ingest route, and an emitter that cannot
  deliver retries rather than discards.
- **Not reconstructible.** A dropped event is revenue that no reconciliation job can recover,
  because nothing else in the system remembers that the second happened. Emitters buffer to disk
  and retry; ingest is idempotent so that retrying is always safe.
- **Not float-fuzzy.** The signature covers the exact IEEE-754 bits of every quantity (see below),
  so a value that changed anywhere between the emitter and the ledger fails verification instead of
  quietly rebilling.
- **Not authenticated by the network.** Anyone who can reach the ingest route can post a batch.
  Only an HMAC over the canonical bytes, with a key the emitters hold, says the batch is real.

## The idempotency-key contract

`UsageEvent::external_id` is the deduplication key. Ingest stores it with a unique index and drops
any event whose key it has already seen.

The rule for emitters: **`external_id` must be a pure function of the measurement**, never of the
attempt. Derive it from the emitter, the subject, the dimension and the measurement window:

```text
metering-agent:<pod-uid>:site_gib_second:<window-start-unix-seconds>
pg-proxy:<database-id>:db_compute_cu_second:<window-start-unix-seconds>
valkey-proxy:<queue-id>:valkey_queue_byte_second:<window-start-unix-seconds>
```

Then a retry after a timeout — the case where the emitter cannot tell whether the first attempt
landed — produces the identical key, and the duplicate is dropped instead of double-billed. A key
containing a timestamp read at _send_ time, a random id, or a retry counter breaks this and turns
every ambiguous timeout into an overcharge.

Two consequences worth stating:

- Re-sending an entire batch is always safe. Emitters should prefer it to giving up.
- An event is immutable once emitted. A correction is a new event, not a re-send of the old key
  with a different quantity — ingest will drop the second one.

## The canonical form

`canonical(&batch)` returns the exact bytes that `sign` covers:

```text
sproutos.metering.v1\n{"events":[...],"source":"pg-proxy"}
```

Rules, all of which are structural rather than conventions the writer has to remember:

1. **Domain separator.** `sproutos.metering.v1` and a newline precede the JSON, so a signature made
   for this schema can never be replayed against a future v2 canonical form.
2. **Sorted keys, no whitespace.** Object keys are written in ascending byte order, always. Batch
   keys are `events`, `source`. Event keys are `attributes`, `dimension`, `external_id`,
   `occurred_at`, `organization_id`, `project_id`, `quantity`.
3. **No optional fields.** `project_id` is written as `null` when absent, `attributes` as `{}` when
   empty. There is no "omit it" form, so there is nothing to disagree about.
4. **Attribute keys are `[a-z0-9._-]`** (enforced by `UsageBatch::validate`). Restricted to ASCII,
   sorting by byte, by code point and by UTF-16 code unit are the same order, so `BTreeMap` in Rust
   and a sorted `Object.keys()` in TypeScript cannot diverge. Values are arbitrary UTF-8.
5. **Strings escape exactly what JSON requires**: `"` and `\`, the short forms `\b \f \n \r \t`,
   and any other character below `U+0020` as `\u00xx` with lowercase hex. Nothing else is escaped —
   non-ASCII is written through as UTF-8. This is what `JSON.stringify` already does.
6. **Quantities are signed as bits.** `quantity` is written as a JSON _string_: the 16 lowercase
   hex digits of the f64's big-endian IEEE-754 bit pattern.

Rule 6 is the one that looks strange, so: `1e21` prints as `1e+21` in JavaScript and
`1000000000000000000000` in Rust. `1e-7` prints as `1e-7` in JavaScript and `0.0000001` in Rust.
Rounding to fixed decimals instead has its own trap — `0.0078125` is exactly representable and sits
exactly on a rounding tie, which Rust breaks to even and JavaScript breaks upward. Any of these
would produce two implementations that sign the same batch differently and reject each other's
traffic, sporadically, in production, on real invoices. The bit pattern has none of these
questions, and it also means a quantity mangled to a neighbouring float in flight fails
verification rather than being billed.

The canonical form is **not** the wire format. On the wire, a batch is ordinary JSON with
`quantity` as a number. A verifier parses that, rebuilds the canonical form from the parsed values,
and checks the signature against it. Both sides:

```text
signature = lowercase_hex(HMAC-SHA256(key, utf8(canonical(batch))))
```

`verify` accepts exactly one spelling — 64 lowercase hex digits — and compares the decoded bytes in
constant time.

A valid signature only says the batch came from something holding the key. Call
`UsageBatch::validate` after verifying and before writing to the ledger; it rejects NaN, infinite
and negative quantities, empty idempotency keys, and attribute keys outside the allowed alphabet.

## The fixture file is the cross-language contract

`fixtures/signing-vectors.json` is the shared truth. The TypeScript verifier and this crate must
both reproduce, for every vector:

- `canonical` — from `batch`, byte for byte;
- `signature` — lowercase hex HMAC-SHA256 over `utf8(canonical)`, keyed with the hex-decoded
  `key_hex`.

Each vector records the canonical string as well as the signature on purpose: when an
implementation disagrees, diffing the canonical string tells you _which_ rule it got wrong in
seconds, where a mismatched hex digest tells you nothing.

The five vectors, and what each one is defending:

| Vector                             | Guards                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `empty-batch`                      | A heartbeat with no events still signs and must be accepted.                                                                                           |
| `single-event-no-project`          | The minimal event: `project_id` present as `null`, `attributes` present as `{}`.                                                                       |
| `unicode-attributes`               | Values carrying astral characters, a control character, a quote and a backslash — the escaping rules.                                                  |
| `multi-event-unordered-attributes` | Attribute keys written out of order; an implementation that preserves insertion order fails here. Also fixes event order as significant.               |
| `float-edge-cases`                 | `1e21`, `1e-7`, `0.0078125`, `0.1`, `0.30000000000000004`, `0` and `2^53` — every quantity whose decimal spelling is a disagreement waiting to happen. |

The vectors in this file were derived by an implementation written independently of `src/lib.rs`,
and the Rust tests assert against them. Two from-scratch implementations agreeing is the evidence
that the rules above are complete enough for a third one, in TypeScript, to match.

Changing the canonical form means bumping `CANONICAL_DOMAIN`, regenerating this file, and shipping
both implementations together. Do not "fix" a vector to make a test pass — a vector that changes is
a signature that stops verifying in production.
