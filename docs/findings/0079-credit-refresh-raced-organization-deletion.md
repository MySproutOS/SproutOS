# 0079 — Credit refresh raced organization deletion

## What was wrong

`billing.refresh_credit_states` first selected every organization and then refreshed each one in a
separate statement. If an account teardown deleted an organization after that initial list, the
refresh attempted to insert its `credit_retention_state` row after the parent was gone. Postgres
correctly rejected the orphan with a foreign-key violation, aborting the platform-wide sweep before
later organizations had their credit state refreshed.

This appeared only when the complete integration suite ran several lifecycle jobs together. The
credit tests passed alone, and the account deletion path passed alone; the bug was the valid state
change between their two reads.

## What stops it recurring

Refreshing one organization now locks its still-live parent row and writes the retention projection
inside the same transaction. A deletion that won the race becomes a harmless skip and clears any
stale Valkey projection. A deletion that arrives second waits for the short refresh transaction and
then cascades the projection normally.

The local object-storage acceptance suite runs the global refresh alongside disposable service
fixtures, which keeps the select/delete race represented rather than replacing it with a mocked
organization list.
