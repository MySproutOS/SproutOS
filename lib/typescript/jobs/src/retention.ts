import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"

/**
 * One retention policy, in one place.
 *
 * Seven tables hold rows that stop being useful on a schedule, and until now each one's policy was
 * asserted where the rows were written — a default here, a comment there, an `expires_at` column
 * with nothing enforcing it. Scattered like that, "how long do we keep X" has no answer anyone can
 * give without reading seven files, which is a problem the first time a customer or a regulator
 * asks.
 *
 * The two rules that shaped every row below:
 *
 * **An expiry is not a deletion.** `session.expires` stops a token working; it does not remove the
 * row, and the row carries an IP address and a user agent. Every one of these tables was already
 * refusing to *honour* expired rows and keeping them forever anyway.
 *
 * **Keep what answers a question later.** A dead-lettered job, a revoked grant, an audit entry —
 * those are the record of something that happened, and deleting them to save bytes trades an
 * answer for nothing. What goes is the row whose only remaining purpose was to be checked and
 * found expired.
 */

export type RetentionRule = {
  /** What is being deleted, for the log line and for `docs/RETENTION.md`. */
  label: string
  /** Days past the row's own expiry — or completion — before it goes. */
  days: number
  /** Why that number, and why not zero. */
  because: string
  delete: (db: Kysely<DB>, days: number, limit: number) => Promise<number>
}

/** Rows removed per table per pass, so one neglected table cannot hold a lock for minutes. */
const BATCH = 5000

export const RETENTION: readonly RetentionRule[] = [
  {
    label: "expired sessions",
    days: 7,
    because:
      "A session row holds an IP and a user agent — personal data whose only purpose ended when the token expired. The week is so that 'why was I signed out' can still be answered from the row rather than guessed.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("session")
          .where("sessionKey", "in", (eb) =>
            eb
              .selectFrom("session as expired")
              .select("expired.sessionKey")
              .where("expired.expires", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "spent authorization codes",
    days: 1,
    because:
      "An authorization code lives sixty seconds. A day past its expiry is already three orders of magnitude of grace, and the row records a redirect URI and the scopes someone consented to.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("oauthAuthorizationCode")
          .where("codeHash", "in", (eb) =>
            eb
              .selectFrom("oauthAuthorizationCode as expired")
              .select("expired.codeHash")
              .where("expired.expiresAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "expired access tokens",
    days: 30,
    because:
      "Introspection and revocation both answer from this table, and answering 'that token was revoked' is more useful than answering 'no such token'. Thirty days outlives any client's retry.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("oauthAccessToken")
          .where("tokenHash", "in", (eb) =>
            eb
              .selectFrom("oauthAccessToken as expired")
              .select("expired.tokenHash")
              .where("expired.expiresAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "expired refresh tokens",
    days: 30,
    /*
      The one with a real trap in it.

      Refresh rotation detects theft by recognising a token that has already been consumed: present
      it twice and the whole family is revoked. Delete consumed tokens too eagerly and a replay
      becomes "unknown token" — refused, but silently, with no family revocation and no signal.

      Keyed on `expires_at` rather than `consumed_at` for that reason: a token past its own expiry
      cannot be exchanged whatever we remember about it, and its family has long since ended. Thirty
      days after that is the point where the detection it enables has nothing left to protect.
    */
    because:
      "Reuse detection reads consumed tokens, so these cannot go on consumption. Keyed on the token's own expiry, past which no exchange can succeed regardless.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("oauthRefreshToken")
          .where("tokenHash", "in", (eb) =>
            eb
              .selectFrom("oauthRefreshToken as expired")
              .select("expired.tokenHash")
              .where("expired.expiresAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "succeeded background jobs",
    days: 30,
    because:
      "Only `succeeded`. A dead-lettered job is the record of something that failed and was never done, which is exactly the row someone will come looking for; it is kept until a human resolves it.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("backgroundJob")
          .where("id", "in", (eb) =>
            eb
              .selectFrom("backgroundJob as old")
              .select("old.id")
              .where("old.state", "=", "succeeded")
              .where("old.finishedAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "processed Stripe webhook events",
    days: 90,
    because:
      "This table is the idempotency ledger for money. Ninety days covers Stripe's own redelivery window several times over, and the payload holds billing details that should not sit here forever.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("stripeWebhookEvent")
          .where("stripeEventId", "in", (eb) =>
            eb
              .selectFrom("stripeWebhookEvent as old")
              .select("old.stripeEventId")
              .where("old.processedAt", "is not", null)
              .where("old.receivedAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
  {
    label: "settled organization invites",
    days: 30,
    because:
      "An invite holds the email address of somebody who may never have become a user, and who therefore has no account through which to ask us to delete it. Accepted, revoked or expired, it has done its job.",
    delete: (db, days, limit) =>
      remove(
        db
          .deleteFrom("organizationInvite")
          .where("id", "in", (eb) =>
            eb
              .selectFrom("organizationInvite as old")
              .select("old.id")
              .where("old.expiresAt", "<", olderThan(days))
              .limit(limit),
          ),
      ),
  },
]

export type SweepResult = { label: string; deleted: number }

/**
 * Apply every rule once.
 *
 * Each rule is batched and looped until it stops finding rows or hits the cap, so the first run
 * against a long-neglected table drains steadily rather than issuing one statement that holds a
 * lock for minutes. Whatever is left is picked up on the next pass.
 */
export async function sweepExpired(db: Kysely<DB>): Promise<SweepResult[]> {
  const results: SweepResult[] = []

  for (const rule of RETENTION) {
    let deleted = 0
    for (let pass = 0; pass < 20; pass += 1) {
      const rows = await rule.delete(db, rule.days, BATCH)
      deleted += rows
      if (rows < BATCH) break
    }
    if (deleted > 0) results.push({ label: rule.label, deleted })
  }

  return results
}

/** `now() - <days>`, evaluated by the database so the cutoff does not depend on this clock. */
function olderThan(days: number) {
  return sql<Date>`now() - make_interval(days => ${days})`
}

/** Run a delete and report how many rows went. Kysely counts in `bigint`; callers want a number. */
async function remove(query: {
  executeTakeFirst: () => Promise<{ numDeletedRows: bigint }>
}): Promise<number> {
  return Number((await query.executeTakeFirst()).numDeletedRows)
}
