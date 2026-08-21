# 0011 — The platform was free

Found by asking a question with an obvious answer: _what has this cost anybody?_

`usage_event` was empty. Not sparse — empty, on a cluster that had served sign-in, a fork of a real
repository, workflow runs, agent sessions, tenant databases and dev sandboxes.

## The agent was working perfectly

`services/metering-agent` runs one pod per node. It discovers pods, reads `cpu.stat` and
`memory.current` out of cgroup v2, computes deltas against its last sample, signs a batch with the
shared HMAC key and posts it to the ingest route. Its own logs said so:

```
{"message":"delivered","count":60}
```

Sixty samples, delivered, accepted. Every one of them attributed to nobody.

It reads two labels off each pod. The control plane wrote different ones:

|                                | key                                                                  |
| ------------------------------ | -------------------------------------------------------------------- |
| the agent reads                | `sproutos.dev/organization-id`, `sproutos.dev/project-id`            |
| `knativeService` wrote         | `sproutos.dev/project` — a different key, and no organization at all |
| the workflow sandbox Job wrote | nothing                                                              |
| the dev sandbox pod wrote      | nothing                                                              |

And the labels Knative did get were on the **Service**, not the pod template — invisible to a node
agent regardless of what they said. The renderer had no pod labels at all.

**There is no error state for billing nothing.** A pod is Running. A cgroup sample is a valid
sample. A batch of unattributed events is a well-formed batch that the ingest route accepts. An
empty `usage_event` reads exactly like a quiet week.

The fix is a vector file, `metering-proto/fixtures/attribution-labels.json`, asserted from both
languages — the same standing as the signing vectors beside it, for a plainer reason: these two
strings are how work becomes money. `organizationId` was made **required** on `SandboxSpec`,
`DevSandboxSpec` and `ProjectSpec`, so the compiler enumerated every unbilled path instead of my
guessing at them, and a new caller cannot forget.

## Then the samples had nowhere to go

With attribution fixed, events flowed and rolled up. `usage_rollup` filled. Balances did not move.

`rated_transaction_id` — a column on `usage_rollup` whose only purpose is to record which
transaction charged a grain — had no writer anywhere in the repository. `rateProjectsForOrganization`
computes cost at read time, deliberately, and its own note explains why: a stored cost is wrong the
moment a rate changes. That is right for a dashboard. It is not a charge, and a prepaid platform
whose balances never fall is a platform giving compute away.

Writing the charge exposed three more, each with the same signature — correct-looking arithmetic
producing a wrong number:

**Charging more than one grain.** `rollUpUsage` writes the same usage at minute, hour and day. A
charge that summed across buckets bills everything three times, and everything downstream agrees
with itself: the ledger balances, the statement adds up, the only wrong number is the one the
customer pays. `assertSingleGrain` makes this structural.

**Usage arriving after its hour was charged.** The rollup upserts, and the metering agent has a
retry buffer, so an event delayed past the five-minute grace by a restart or a partition is ordinary.
The claim looked for `rated_transaction_id is null`, so a topped-up grain was never looked at again
and the addition was free. Clearing the marker instead would bill the paid part twice. The row now
carries `charged_quantity` and the charge is the difference.

**An idempotency key that could not tell a retry from new work.** Keyed on the row ids and their
count — which are _identical_ when a charged grain is topped up and re-claimed. The key matched the
earlier transaction, `postWithin` returned it having written nothing, and the job reported a charge
that never happened: right size, in the logs, balance unmoved. The key is now a function of the
state transition, and the total only counts a posting that was actually created.

A test caught the second and third. Neither would have survived review, because both read correctly.

## What it looks like working

```
[jobs] charged $0.000755 across 1 organization(s), 2 grain(s)

credit_ledger_entry   user_credit      -755   (1 entry)
                      platform_revenue  +755  (2 entries: usage, overhead)
usage_rollup          hour    charged_quantity = quantity, stamped
                      minute, day   untouched
```

## Two of my own tests were the bug

Worth recording because both failures pointed at innocent files.

`afterAll` in the new charge test ran `deleteFrom("creditLedgerEntry").execute()` — no `where`,
every ledger entry in the database, belonging to every test file running in parallel against it. The
failure surfaced in `holds.test.ts`, as _"frees a balance a vanished runner would otherwise strand"_.

And `rollUpUsage` and `chargeUsage` are platform-wide sweeps by design: they cannot take an
organization, because their job is to sweep everything owed. Two test files driving them in parallel
claim each other's rows. `rollup.test.ts` asserted a grain of 1.75 and found 3.75 — another file's
sweep had folded in an event it had not rolled up yet, and the assertion that broke was in the file
that had done nothing wrong. A session-scoped advisory lock makes those two files take turns.

## The shape, again

Every defect in this record is a component that works, connected to a component that works, by a
name or a marker that does not line up.

- A label the meter reads and a label the platform writes, differing by five characters.
- Those labels on the Service rather than on the pod.
- A column that records _whether_ a grain was charged, in a system where a grain can be charged
  twice for different reasons.
- An idempotency key that describes the rows rather than the work.

None of them produces an error. Three of the four produce a number that is internally consistent and
wrong. The fourth produces an empty table that looks like an idle platform.

That is the same finding as 0001 and 0010, in the part of the system where being wrong costs money:
**the checks that matter are the ones that compare two components against a third thing both must
agree with.** A fixture file, asserted from both sides. Not a comment saying they match.
