# What SproutOS keeps, and for how long

One policy, in one place. Six of these periods were previously asserted independently — a column
default here, a comment there, an `expires_at` with nothing enforcing it — which meant "how long do
we keep X" had no answer anybody could give without reading six files. That is a problem the first
time a customer or a regulator asks.

Two rules shaped every row below.

**An expiry is not a deletion.** `session.expires` stops a token working. It does not remove the
row, and the row holds an IP address and a user agent. Nearly every table here was already refusing
to _honour_ expired rows while keeping them indefinitely.

**Keep what answers a question later.** A dead-lettered job, a revoked grant, an audit entry — each
is the record of something that happened, and deleting it to save bytes trades an answer for
nothing. What goes is the row whose only remaining purpose was to be checked and found expired.

## The table

| Data                              | Kept                                    | Enforced by                | Why that period                                                                                                                      |
| --------------------------------- | --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions                          | 7 days past expiry                      | `platform.retention_sweep` | The row holds an IP and a user agent. The week is so "why was I signed out" is answerable from the row rather than guessed.          |
| OAuth authorization codes         | 1 day past expiry                       | `platform.retention_sweep` | A code lives 60 seconds. A day is three orders of magnitude of grace.                                                                |
| OAuth access tokens               | 30 days past expiry                     | `platform.retention_sweep` | Introspection and revocation answer from this table, and "that token was revoked" beats "no such token".                             |
| OAuth refresh tokens              | 30 days past **the token's own expiry** | `platform.retention_sweep` | See the trap below.                                                                                                                  |
| Background jobs                   | 30 days after success                   | `platform.retention_sweep` | **Succeeded only.** Dead-lettered, failed and cancelled rows stay until a human resolves them.                                       |
| Stripe webhook events             | 90 days                                 | `platform.retention_sweep` | The idempotency ledger for money, and the payload holds billing details. Covers Stripe's redelivery window many times over.          |
| Organization invites              | 30 days past expiry                     | `platform.retention_sweep` | Holds the email of someone who may never have become a user — and who therefore has no account through which to ask us to delete it. |
| Agent transcripts (`agent_event`) | 30 days                                 | `agent.purge_events`       | `payload` holds tool calls and file contents from a customer's repository.                                                           |
| Logs (`log_record`)               | 7 / 30 / 90 days, per stream            | ClickHouse per-row TTL     | The customer chooses; the TTL is stored on the row so one table serves every tier.                                                   |
| Credit holds                      | Expired hourly                          | `billing.expire_holds`     | A hold nobody closed is a customer's money made unspendable by a process that no longer exists.                                      |
| Audit log                         | **Indefinitely**                        | —                          | It exists to answer questions about the past. A retention period on an audit trail is a hole in it.                                  |
| Usage events and ledger entries   | **Indefinitely**                        | —                          | Billing history. Deleting it makes past statements unreconcilable.                                                                   |

## The one with a trap in it

Refresh-token rotation detects theft by recognising a token that has already been consumed: present
it twice and the whole family is revoked.

A sweep keyed on `consumed_at` would delete precisely the rows that detection depends on. A replayed
token would become an unremarkable "unknown token" — refused, but silently, with no family
revocation and no signal that anything had been stolen. Retention would have quietly removed a
security control.

So the rule is keyed on the token's **own** `expires_at`, past which no exchange can succeed
whatever we remember about it. `retention.test.ts` asserts a token consumed long ago but not yet
expired survives, and switching the rule to `consumed_at` turns it red.

## Deletion is not retention

Retention is a schedule. Deletion is a customer's request, and it is handled elsewhere:

- `deleteUser` clears personal data and revokes every credential — see `lib/typescript/dao/src/user/crud.ts`.
- `GET /v1/user/me/export` hands someone their record before they go.
- `@lib/reaper` removes a deleted tenant's Valkey keys, OpenSearch indices and ClickHouse log rows,
  which no foreign key reaches from Postgres.

## Changing a period

Every rule in `lib/typescript/jobs/src/retention.ts` carries a `because`, and a test asserts that it
is there and is more than a sentence fragment. A retention period nobody can defend is one that gets
changed by whoever next finds it inconvenient.
