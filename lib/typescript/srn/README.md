# `@lib/srn`

SproutOS Resource Names in TypeScript — the resource half of every authorization decision the API
makes. This is the mirror of the Rust crate in [`lib/rust/srn`](../../rust/srn); read that crate's
`README.md` for the grammar itself, which is normative and is not restated here.

```text
srn:sproutos:<service>:<org_id>:<type>/<id>
```

## The fixture file is the contract, not this README

`../../rust/srn/fixtures/srn-cases.json` is read directly by `src/srn.test.ts` — the same path the
Rust tests read, not a copy. `pg-proxy` and `valkey-proxy` authorize against the Rust
implementation and the API authorizes against this one, so a case the two sides answer differently
is authority silently granted or revoked in one of them. The suite derives four things from the
file:

1. **Matching** — `pattern` parsed as a pattern, `target` as a name, asserted against `matches`.
2. **Round-tripping** — every `pattern` and `target` parses and formats back byte for byte.
3. **Rejection** — every string in `invalid` fails to parse, as a name and as a pattern.
4. **Expansion equivalence** — see below. This one has no Rust counterpart, because only the
   TypeScript side talks to Postgres.

Changing the grammar means changing the fixture first, in the same commit as both
implementations.

## Usage

```ts
import { parseSrn, parseSrnPattern, srnFor, srnPatternMatches } from "@lib/srn"

const target = parseSrn(srnFor("db", organizationId, "database", databaseId))
const grant = parseSrnPattern("srn:sproutos:db:*:database/*")

srnPatternMatches(grant, target) // true
```

`srnFor(service, organizationId, type, id)` is the constructor route handlers use. It lowercases
the organization id and the resource id, because the grammar rejects uppercase outright and a
client that sends an uppercased UUID should not turn into a parse failure at the authorization
boundary. `SRN_SERVICES` is the vocabulary of services the platform actually uses; the grammar
accepts any lowercase token, so the list exists to make a typo in a route a type error rather than
a permission that silently never matches.

## Target expansion, and why it exists

`srnPatternMatches` is a function. The grants it would have to run against live in a Postgres
`text[]` column with a GIN index, and Postgres cannot call it. So the permission query turns the
question around.

Instead of asking _"does any stored pattern match this target"_, it asks _"is any stored pattern a
member of the set of patterns that match this target"_ — and that set is finite and small. Each of
the three variable segments has at most two forms (itself and `*`), and the resource tail has at
most five (`type/id`, `type/*`, `*/id`, `*/*`, and the bare `*`), so `expandSrnTarget` returns at
most twenty strings. The query is then a single indexed `resources && $expanded`.

```ts
expandSrnTarget(parseSrn("srn:sproutos:db:<org>:database/main"))
// srn:sproutos:db:<org>:*            srn:sproutos:*:<org>:*
// srn:sproutos:db:<org>:database/main  srn:sproutos:*:<org>:database/main
// srn:sproutos:db:<org>:database/*     srn:sproutos:*:<org>:database/*
// srn:sproutos:db:<org>:*/main         srn:sproutos:*:<org>:*/main
// srn:sproutos:db:<org>:*/*            srn:sproutos:*:<org>:*/*
// … and the same ten with `*` in the organization segment
```

The rewrite is only safe if it agrees with `srnPatternMatches` on every input, which is why the
test suite runs the whole fixture file through it a second time and asserts
`expandSrnTarget(target).includes(pattern) === case.matches`. Three cases in the contract are
easy to get wrong here and each has a test:

- A `*` in a **target** is a literal segment. `expandSrnTarget` of a target whose organization is
  the literal `*` yields only `*` in that position, so a grant naming a concrete organization does
  not cover it. A caller cannot widen their own authority by putting `*` in the thing they ask
  about.
- The bare `*` resource is not the same as `*/*`. A target of `database/main` is covered by both;
  a target that is itself the bare `*` is covered only by the bare `*`.
- Segments are compared exactly, never by prefix. `db` does not cover `db2`, and `queue/orders`
  does not cover `queue/orders.dlq`.

## What this package deliberately does not do

It does not know what an _action_ is, and it does not know whether an organization exists. Actions
live in the catalogue at `apps/internal-api/src/rbac/actions.ts`; organization existence is a
database question answered by `requirePermission`. The grammar here is purely syntactic, which is
what lets the same five-segment string be produced by a Rust proxy and consumed by a TypeScript
route without either side needing the other's tables.
