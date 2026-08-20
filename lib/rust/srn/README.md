# `sproutos-srn`

SproutOS Resource Names — the resource grammar every authorization decision is written in.

```text
srn:sproutos:<service>:<org_id>:<type>/<id>
```

```text
srn:sproutos:db:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:database/main
srn:sproutos:workflow:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:run/01912d43-0000-7000-8000-0000000000d1
srn:sproutos:store:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:queue/orders.dlq
```

## Grammar

```text
srn      = "srn:sproutos:" service ":" org ":" resource
service  = token                       ; project | db | workflow | store | billing | oauth | search
org      = token                       ; a UUIDv7 in practice, or "*"
resource = "*" / type "/" id
type     = token                       ; database | queue | index | run | invoice | client | ...
id       = token                       ; a UUIDv7 or a slug, or "*"
token    = "*" / 1*( %x61-7A / %x30-39 / "." / "_" / "-" )
```

An SRN is exactly five `:`-separated segments. The first two are the fixed literal
`srn:sproutos`. Every remaining segment is either the single character `*` or a non-empty run of
**lowercase** ASCII letters, digits, `.`, `_` and `-`.

Three rules are stricter than they strictly have to be, on purpose:

- **Lowercase only.** `DB` and `db` are not two spellings of one service, they are one spelling and
  one parse error. A grammar where case folding is a judgement call is a grammar where two
  implementations eventually disagree about who is authorized.
- **`*` is a whole segment or nothing.** `database/prod-*` does not mean "ids starting with
  `prod-`"; it is rejected. A pattern that silently matches nothing is the worst possible failure
  mode for an allow-list.
- **512-byte cap.** Untrusted input never makes the parser walk an unbounded string.

The organization segment is _not_ checked to be a UUID. The grammar is syntactic; whether an
organization exists is a database question. Use [`Srn::organization_uuid`] when you want the parsed
UUID, and `None` tells you the segment was `*` or something else.

## Wildcard rules

`SrnPattern` is the same grammar read as a pattern. `SrnPattern::matches(&target)` compares
segment by segment:

| Pattern segment     | Target segment                       | Matches                                       |
| ------------------- | ------------------------------------ | --------------------------------------------- |
| `*`                 | anything (exactly one segment)       | yes                                           |
| `db`                | `db`                                 | yes                                           |
| `db`                | `db2`, `d`, `store`                  | no — comparison is exact, never a prefix test |
| `*` (bare resource) | `database/main`, `queue/orders`, `*` | yes — it matches the whole `<type>/<id>` tail |
| `*/*`               | `database/main`                      | yes                                           |
| `*/*`               | `*` (bare resource)                  | no — a typed pattern needs a typed target     |
| `database/*`        | `database/main`                      | yes                                           |
| `database/*`        | `backup/main`                        | no                                            |

Two consequences worth stating out loud:

- **Wildcards in a _target_ are literal.** `srn:sproutos:db:<org>:*` as a target is a name whose
  resource segment happens to be the character `*`; it does not ask to be widened. Only the
  pattern side expands. So a grant of `db/main` never matches a target of `*`, and a caller cannot
  smuggle extra authority in by putting `*` in the thing they are asking about.
- **Matching is per segment, and `*` covers exactly one.** The only "matches the rest" form is the
  bare `*` resource segment, which stands in for the entire `<type>/<id>` tail.

Typical policy patterns:

```text
srn:sproutos:*:<org>:*                     everything owned by one organization
srn:sproutos:db:*:database/*               every database, any organization (an operator grant)
srn:sproutos:workflow:<org>:run/*          every workflow run in one organization
srn:sproutos:billing:<org>:invoice/*       one organization's invoices
```

## The fixture file is the cross-language contract

`fixtures/srn-cases.json` is the shared truth for this grammar. The TypeScript implementation
mirrors this crate, and both sides must pass every case in that file. Nothing else — not this
README, not the Rust source — is the contract.

```jsonc
{
  "$comment": "...",
  "cases": [
    {
      "pattern": "srn:sproutos:db:*:database/*",
      "target": "srn:sproutos:db:0191...:database/main",
      "matches": true,
      "note": "type-scoped pattern across all organizations",
    },
  ],
  "invalid": ["srn:sproutos:db:0191...:database/prod-*", "..."],
}
```

Each implementation must derive three test suites from it:

1. **Matching** — parse `pattern` as a pattern, `target` as a name, assert `matches`.
2. **Round-tripping** — every `pattern` and every `target` is a valid SRN whose parse-then-format
   output equals the input byte for byte.
3. **Rejection** — every string in `invalid` must fail to parse, both as a name and as a pattern.

`note` is documentation for whoever is staring at a failure; it has no semantics.

Changing the grammar means changing the fixture first, in the same commit as both implementations.
A case removed from this file is authority silently granted or revoked somewhere.

## Usage

```rust
use sproutos_srn::{Srn, SrnPattern};

let target: Srn = "srn:sproutos:db:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:database/main".parse()?;

let grants: Vec<SrnPattern> = vec!["srn:sproutos:db:*:database/*".parse()?];
if !SrnPattern::any_match(&grants, &target) {
    // deny
}
# Ok::<(), sproutos_srn::ParseError>(())
```

`Srn` and `SrnPattern` serialize as their string form, so they drop straight into API payloads and
database columns.

[`Srn::organization_uuid`]: https://docs.rs/sproutos-srn
