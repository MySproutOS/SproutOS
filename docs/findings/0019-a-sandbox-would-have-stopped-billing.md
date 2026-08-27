# 0019 — One unused feature would have stopped billing for everybody

The list of billable dimensions lives in four check constraints: `usage_event`,
`price_book_item`, `usage_rollup`, `statement_line_item`. Sandbox billing widened
two of them.

The migration that did it says, in its own comment:

> Both tables get it: `usage_event` because the meter writes there every minute,
> and `price_book_item` because the seed writes the rate. A row on either side
> without the other is a dimension that meters and never rates.

It was right about the mechanism and wrong about the count.

## What it would have done

Not "sandboxes are not billed", which is what it looks like. `rollUpUsage` is one
job over **every** organization's unrated events. The first metered sandbox
anywhere makes it throw on `usage_rollup_dimension_check`, and it throws on every
run after that, because the offending event is still unrated.

So: no usage rolled up, no usage charged, for every customer on the platform, for
as long as one sandbox had ever run. A feature nobody had used yet would have
stopped the billing of everybody who had.

`chargeUsage` runs behind the rollup on the same ten-minute schedule, so it would
have gone quiet at the same moment — with nothing failing in a way anybody
watches. The job retries, dead-letters, and the dashboard's cost figure simply
stops moving.

## How it was found

By metering a sandbox for the first time. The docker driver made a sandbox
possible on a developer's machine; the reaper test metered one before stopping
it; six billing tests that had nothing to do with sandboxes started failing on a
constraint. The rows were real usage from a real code path — the tests were the
messenger, not the victim.

Nothing else would have found it. There is no sandbox in production, no Daytona
key anywhere, and the constraint is only reachable by _rolling up_ an event, not
by writing one.

## Why the fix is a superset and not an alignment

The first attempt made all four lists identical, which meant dropping
`site_vcpu_second` and `site_active_cpu_second` from the two that were behind. It
refused to run — its own guard found five `usage_rollup` rows on those
dimensions, rolled up before Lambda retired them.

Deleting rows an invoice is reconciled from, to fix a bug about billing, is worse
than the bug. So the rule downstream is a superset: a rollup or a line item may
carry a dimension no new event can be written on, because history happened. The
reverse — a dimension the meter can write and the rollup refuses — is the one
that must never be true.

## What stops it coming back

`lib/typescript/billing/src/dimension-checks.test.ts` reads all four constraints
out of `pg_constraint` and asserts:

- every dimension `usage_event` permits is permitted downstream,
- every dimension `usage_event` permits is priced in `price_book_item`,
- and every one of them has a rate in the _current_ price book, not merely
  permission to have one.

Deliberately not a list in the test file — a list there would be the fifth copy
of the thing that went wrong.

Demonstrated: with the migration rolled back, the test fails with
`usage_rollup refuses dimensions the meter can write: [ 'sandbox_cpu_second', …(2) ]`.

## The general shape

This is the third of its kind in `docs/findings`: **one idea, expressed in more
than one place, where nothing checks that the places agree.** 0016 was a
credential check one layer under the one that was checked; 0018 was an artifact
nothing in the tree produced. Here it is a list of twenty strings in four tables.

The question worth asking of a check is not whether it passes but what would have
to be true for it to fail. For a constraint that is a copy of another constraint,
the answer is: someone edits one of them. That is not a hypothetical, it is a
Tuesday.
