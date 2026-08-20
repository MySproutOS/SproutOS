import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { v7 } from "uuid"

export type JobState =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "dead_lettered"
  | "cancelled"

export type Job = {
  id: string
  organizationId: string | null
  kind: string
  payload: unknown
  attempt: number
  maxAttempts: number
}

export type EnqueueInput = {
  kind: string
  organizationId?: string | null
  payload?: unknown
  runAt?: Date
  priority?: number
  maxAttempts?: number
  /**
   * Makes enqueueing exactly-once. A webhook redelivery, a retried request, or a cron that fires
   * twice reuses the key and the second attempt returns the job already queued.
   */
  idempotencyKey?: string | null
}

/**
 * Enqueue, returning the existing job when the idempotency key has been seen.
 *
 * The unique constraint is what settles a race between two enqueues; the `doNothing` makes the
 * loser a no-op rather than an error the caller has to distinguish from a real failure.
 */
export async function enqueue(db: Kysely<DB>, input: EnqueueInput): Promise<string> {
  const values = {
    id: v7(),
    kind: input.kind,
    organizationId: input.organizationId ?? null,
    payload: JSON.stringify(input.payload ?? {}),
    // The database clock, not this process's. `claim` compares `run_at <= now()` in Postgres, so
    // a default taken from the application clock makes a job briefly unclaimable whenever the two
    // disagree — which they do, by the round trip if nothing else. An explicit runAt is a real
    // schedule and stays as the caller gave it.
    runAt: input.runAt ?? sql<Date>`now()`,
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? 5,
    idempotencyKey: input.idempotencyKey ?? null,
  }

  const inserted = await db
    .insertInto("backgroundJob")
    .values(values)
    .onConflict((oc) => oc.column("idempotencyKey").doNothing())
    .returning("id")
    .executeTakeFirst()

  if (inserted !== undefined) return inserted.id

  const existing = await db
    .selectFrom("backgroundJob")
    .select("id")
    .where("idempotencyKey", "=", input.idempotencyKey!)
    .executeTakeFirstOrThrow()

  return existing.id
}

/**
 * Claim up to `limit` jobs for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole design. Two workers polling the same queue would otherwise
 * either serialize behind each other's row locks or hand the same job to both; SKIP LOCKED lets
 * the second worker step over rows the first has taken and claim the next ones instead.
 *
 * A *lease* rather than a lock: the transaction commits immediately, so a worker that dies holding
 * a job does not hold a database connection open until someone notices. `lease_expires_at` is the
 * deadline, and `reclaimExpired` is what enforces it.
 *
 * The result is a **set, not a sorted list**. Priority and age decide which rows the subquery
 * selects; `RETURNING` hands them back in whatever order the UPDATE produced them. A caller that
 * needs the highest-priority job specifically should claim with `limit: 1`.
 */
export async function claim(
  db: Kysely<DB>,
  workerId: string,
  options: { kinds?: readonly string[]; limit?: number; leaseSeconds?: number } = {},
): Promise<Job[]> {
  const limit = options.limit ?? 1
  const leaseSeconds = options.leaseSeconds ?? 300
  const kinds = options.kinds

  const rows = await db

    /*
      A CTE, not `where id in (select … limit n for update skip locked)`.

      The subquery form does not reliably bound the UPDATE. Written that way, `claim(limit: 1)` was
      observed returning **three** jobs against the real table: the worker took work it then left
      in `running` until the leases expired, so the queue advanced one job per lease interval and
      looked like a hang. The same statement run again by hand returned one row, so it is not
      deterministic — which is worse than being consistently wrong, because it behaves in a small
      test and misbehaves under load.

      I have not pinned down the exact plan that produces it, and the mechanism does not much
      matter: a CTE is an optimization fence, so the limit and the row locks are evaluated exactly
      once, by construction rather than by luck. This is why the canonical SKIP LOCKED queue is
      always written as a CTE.
    */
    .with("ready", (qb) =>
      qb
        .selectFrom("backgroundJob")
        .select("id")
        .where("state", "=", "queued")
        .where("runAt", "<=", sql<Date>`now()`)
        .$if(kinds !== undefined && kinds.length > 0, (inner) =>
          inner.where("kind", "in", [...kinds!]),
        )
        // Highest priority first, then oldest — so a burst of new work cannot starve a job that
        // has been waiting.
        .orderBy("priority", "desc")
        .orderBy("runAt", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked(),
    )
    .updateTable("backgroundJob")
    .from("ready")
    .whereRef("backgroundJob.id", "=", "ready.id")
    .set({
      state: "running",
      lockedBy: workerId,
      leaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
      startedAt: sql<Date>`coalesce(background_job.started_at, now())`,
      attempt: sql<number>`background_job.attempt + 1`,
      updatedAt: sql<Date>`now()`,
    })
    .returning([
      "backgroundJob.id as id",
      "backgroundJob.organizationId as organizationId",
      "backgroundJob.kind as kind",
      "backgroundJob.payload as payload",
      "backgroundJob.attempt as attempt",
      "backgroundJob.maxAttempts as maxAttempts",
    ])
    .execute()

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    payload: row.payload,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
  }))
}

export async function succeed(db: Kysely<DB>, jobId: string): Promise<void> {
  await db
    .updateTable("backgroundJob")
    .set({
      state: "succeeded",
      finishedAt: new Date(),
      leaseExpiresAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where("id", "=", jobId)
    .execute()
}

/**
 * Record a failure, and decide whether it gets another go.
 *
 * Backoff is exponential from the attempt count already stored on the row, so a retry schedule
 * survives the worker that scheduled it dying. The cap keeps a job that has failed four times from
 * being rescheduled hours out, where nobody will see it fail the fifth time.
 */
export async function fail(
  db: Kysely<DB>,
  job: Pick<Job, "id" | "attempt" | "maxAttempts">,
  error: unknown,
): Promise<"retrying" | "dead_lettered"> {
  const exhausted = job.attempt >= job.maxAttempts
  const backoffSeconds = Math.min(2 ** job.attempt * 15, 3600)

  await db
    .updateTable("backgroundJob")
    .set({
      state: exhausted ? "dead_lettered" : "queued",
      // Cleared either way: a dead-lettered job is not leased by anyone, and a retrying one must
      // be claimable by whichever worker gets there first.
      lockedBy: null,
      leaseExpiresAt: null,
      runAt: exhausted
        ? sql<Date>`run_at`
        : sql<Date>`now() + make_interval(secs => ${backoffSeconds})`,
      finishedAt: exhausted ? new Date() : null,
      lastError: describe(error),
      updatedAt: new Date(),
    })
    .where("id", "=", job.id)
    .execute()

  return exhausted ? "dead_lettered" : "retrying"
}

/**
 * Return jobs whose lease ran out to the queue.
 *
 * A worker that is killed mid-job leaves a row in `running` that nothing will ever finish. The
 * lease is the only thing that distinguishes "in progress" from "abandoned", so this is what makes
 * the queue survive a pod being evicted.
 *
 * Attempts are not reset: a job that reliably kills its worker is a job that should dead-letter
 * rather than take out every worker in the pool, one at a time, forever.
 */
export async function reclaimExpired(db: Kysely<DB>, limit = 100): Promise<number> {
  const result = await db
    .updateTable("backgroundJob")
    .set({
      state: "queued",
      lockedBy: null,
      leaseExpiresAt: null,
      lastError: "Lease expired; the worker holding this job did not finish it",
      updatedAt: new Date(),
    })
    .where((eb) =>
      eb(
        "id",
        "in",
        eb
          .selectFrom("backgroundJob as stale")
          .select("stale.id")
          .where("stale.state", "=", "running")
          .where("stale.leaseExpiresAt", "<", sql<Date>`now()`)
          .limit(limit),
      ),
    )
    .executeTakeFirst()

  return Number(result.numUpdatedRows)
}

/** Extend a lease from inside a long job, so it is not reclaimed while it is still working. */
export async function heartbeat(
  db: Kysely<DB>,
  jobId: string,
  workerId: string,
  leaseSeconds = 300,
): Promise<boolean> {
  const result = await db
    .updateTable("backgroundJob")
    .set({
      leaseExpiresAt: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where("id", "=", jobId)
    // Scoped to the holder: a worker whose lease was already reclaimed and handed to someone else
    // must not extend it back out from under them.
    .where("lockedBy", "=", workerId)
    .where("state", "=", "running")
    .executeTakeFirst()

  return Number(result.numUpdatedRows) > 0
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 2000)
  return String(error).slice(0, 2000)
}
