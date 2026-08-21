import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Separate "already paid for" from "already rolled up".
 *
 * `usage_event.rated_at` was doing both jobs and they are not the same fact. `rollUpUsage` sets it
 * to mean *this event has been folded into `usage_rollup`*. The agent set it at write time to mean
 * something else entirely: *do not charge for this, the hold already did*.
 *
 * The consequence is a bill a customer cannot read. An agent run charges through
 * `placeHold`/`settleHold`, so the money is taken — and because those events arrive pre-stamped,
 * `rollUpUsage` skips them, they never reach `usage_rollup`, and both the statement and the
 * dashboard's project cost are built from `usage_rollup`. **AI tokens are the largest line in this
 * product and they appear on no statement at all.**
 *
 * `recordTokenUsage` says why it exists: "A charge with no matching events is a bill nobody can
 * explain." It was right, and the events it wrote were being filtered out one step later.
 *
 * So the two facts get two columns. `charged_externally` means the money was taken by something
 * other than `chargeUsage` — today only the agent's hold settlement. `rollUpUsage` folds those
 * events in like any other, and credits the resulting grain's `charged_quantity` at the same time,
 * so the usage is *visible* and `chargeUsage` will never bill it twice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table usage_event
      add column charged_externally boolean not null default false
  `.execute(db)

  /*
    Existing pre-stamped events are the agent's, and they were charged by its hold.

    Identified by `source`, which is the only marker they carry. They stay `rated_at` — rolling them
    up now would show a month's AI usage appearing on the day this migration ran, which is a worse
    lie than the omission it replaces. New runs are visible from here on.
  */
  await sql`
    update usage_event set charged_externally = true
    where source = 'agent' and rated_at is not null
  `.execute(db)

  // The rollup scans on this; without it, adding a second predicate to that query turns a partial
  // index scan into a sequential one over every event the platform has ever recorded.
  await sql`
    create index usage_event_unrated_external_idx
      on usage_event (occurred_at)
      where rated_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists usage_event_unrated_external_idx`.execute(db)
  await sql`alter table usage_event drop column charged_externally`.execute(db)
}
