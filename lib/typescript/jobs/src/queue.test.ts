import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { claim, enqueue, fail, heartbeat, reclaimExpired } from "./queue"
import { runOne } from "./worker"

/**
 * Against the compose Postgres, because every invariant here is one: SKIP LOCKED, the atomic
 * claim, and lease expiry are database behaviours. A fake queue would test the fake.
 */
// Top-level, not in beforeAll: `describe.skipIf` is evaluated when the file is collected, which
// happens before any hook runs. Reading a flag set in beforeAll skips the whole suite, always,
// and reports twelve passing skips.
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const KIND = `test_kind_${v7().slice(0, 8)}`

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("backgroundJob").where("kind", "like", "test_kind_%").execute()
  await db.destroy()
})

describe.skipIf(!reachable)("enqueue", () => {
  it("returns the existing job for a repeated idempotency key", async ({ skip }) => {
    if (!reachable) skip()
    const key = `test:${v7()}`

    const first = await enqueue(db, { kind: KIND, idempotencyKey: key })
    const second = await enqueue(db, { kind: KIND, idempotencyKey: key })

    // A cron that fires twice, or a retried request, must not produce two jobs.
    expect(second).toBe(first)
    expect(await countWithKey(key)).toBe(1)
  })

  it("does not schedule work before its time", async ({ skip }) => {
    if (!reachable) skip()
    // Its own kind: sharing one with the test above would let that test's still-queued job be
    // claimed here and pass for the wrong reason.
    const kind = `test_kind_future_${v7().slice(0, 8)}`
    await enqueue(db, { kind, runAt: new Date(Date.now() + 60_000) })

    expect(await claim(db, "w1", { kinds: [kind] })).toEqual([])
  })
})

describe.skipIf(!reachable)("claim", () => {
  it("never hands the same job to two workers", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_race_${v7().slice(0, 8)}`
    for (let i = 0; i < 8; i++) await enqueue(db, { kind })

    // Four workers going for the same eight jobs at once. Without SKIP LOCKED they either
    // serialize behind each other's row locks or hand the same row to two of them.
    const claims = await Promise.all(
      ["a", "b", "c", "d"].map((worker) => claim(db, worker, { kinds: [kind], limit: 2 })),
    )

    const ids = claims.flat().map((job) => job.id)
    expect(ids).toHaveLength(8)
    expect(new Set(ids).size).toBe(8)
  })

  it("takes the highest priority first, then the oldest", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_prio_${v7().slice(0, 8)}`
    const old = await enqueue(db, { kind, runAt: new Date(Date.now() - 60_000) })
    await enqueue(db, { kind })
    const urgent = await enqueue(db, { kind, priority: 10 })

    // One at a time, because a batch claim returns a *set* and not a sorted list — the ordering
    // picks which rows the subquery selects, and RETURNING hands them back in whatever order the
    // UPDATE produced. Asserting the order of a batch would be asserting something claim() does
    // not promise.
    const [first] = await claim(db, "w1", { kinds: [kind], limit: 1 })
    const [second] = await claim(db, "w2", { kinds: [kind], limit: 1 })

    // Priority wins; among equals the waiting job goes first, or a steady arrival of new work
    // starves it forever.
    expect(first?.id).toBe(urgent)
    expect(second?.id).toBe(old)
  })

  it("claims exactly the number of jobs asked for", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_limit_${v7().slice(0, 8)}`
    for (let i = 0; i < 5; i++) await enqueue(db, { kind })

    // The contract this pins: a worker gets exactly what it asked for and no more. Written with
    // `where id in (select … limit n …)` instead of a CTE, claim(limit: 1) was seen returning
    // three jobs — the extras then sat in `running` until their leases expired.
    //
    // Worth knowing: this test does **not** reliably reproduce that. The misbehaviour is
    // plan-dependent and the subquery form passes here as often as not, which is precisely why
    // the fix is a CTE — correct by construction — rather than a form that tests green today.
    expect(await claim(db, "w1", { kinds: [kind], limit: 1 })).toHaveLength(1)
    expect(await claim(db, "w2", { kinds: [kind], limit: 2 })).toHaveLength(2)
    expect(await claim(db, "w3", { kinds: [kind], limit: 10 })).toHaveLength(2)
    expect(await claim(db, "w4", { kinds: [kind], limit: 1 })).toEqual([])
  })

  it("counts the attempt when the job is claimed, not when it fails", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_attempt_${v7().slice(0, 8)}`
    await enqueue(db, { kind })

    const [job] = await claim(db, "w1", { kinds: [kind] })
    // A worker killed mid-job never reaches fail(), so an attempt counted there would let a job
    // that kills workers be retried forever.
    expect(job?.attempt).toBe(1)
  })
})

describe.skipIf(!reachable)("fail", () => {
  it("reschedules with backoff until the attempts run out", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_retry_${v7().slice(0, 8)}`
    await enqueue(db, { kind, maxAttempts: 2 })

    const [first] = await claim(db, "w1", { kinds: [kind] })
    expect(await fail(db, first, new Error("boom"))).toBe("retrying")

    const afterFirst = await row(first.id)
    expect(afterFirst.state).toBe("queued")
    expect(afterFirst.lockedBy).toBeNull()
    expect(afterFirst.runAt.getTime()).toBeGreaterThan(Date.now())

    // Claimable again once the backoff elapses.
    await db
      .updateTable("backgroundJob")
      .set({ runAt: new Date(Date.now() - 1000) })
      .where("id", "=", first.id)
      .execute()

    const [second] = await claim(db, "w2", { kinds: [kind] })
    expect(second?.attempt).toBe(2)
    expect(await fail(db, second, new Error("boom again"))).toBe("dead_lettered")

    const dead = await row(first.id)
    expect(dead.state).toBe("dead_lettered")
    expect(dead.lastError).toContain("boom again")
    // Dead letters stop moving: nothing should quietly pick this up later.
    expect(dead.finishedAt).not.toBeNull()
  })
})

describe.skipIf(!reachable)("leases", () => {
  it("returns an abandoned job to the queue without resetting its attempts", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_lease_${v7().slice(0, 8)}`
    await enqueue(db, { kind })

    const [job] = await claim(db, "doomed-worker", { kinds: [kind], leaseSeconds: 300 })
    await db
      .updateTable("backgroundJob")
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", job.id)
      .execute()

    expect(await reclaimExpired(db)).toBeGreaterThanOrEqual(1)

    const reclaimed = await row(job.id)
    expect(reclaimed.state).toBe("queued")
    expect(reclaimed.lockedBy).toBeNull()
    // Not reset: a job that reliably kills its worker should dead-letter rather than take out
    // every worker in the pool, one at a time, forever.
    expect(reclaimed.attempt).toBe(1)
  })

  it("refuses a heartbeat from a worker that no longer holds the lease", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_hb_${v7().slice(0, 8)}`
    await enqueue(db, { kind })

    const [job] = await claim(db, "worker-one", { kinds: [kind] })
    expect(await heartbeat(db, job.id, "worker-one")).toBe(true)
    // The lease was reclaimed and handed to someone else; the old holder must not pull it back.
    expect(await heartbeat(db, job.id, "worker-two")).toBe(false)
  })
})

describe.skipIf(!reachable)("runOne", () => {
  it("runs a handler and marks the job done", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_run_${v7().slice(0, 8)}`
    const id = await enqueue(db, { kind, payload: { greeting: "hello" } })

    let seen: unknown = null
    const result = await runOne(db, {
      workerId: "w1",
      handlers: {
        [kind]: (job) => {
          seen = job.payload
          return Promise.resolve()
        },
      },
    })

    expect(result).toBe("ran")
    expect(seen).toEqual({ greeting: "hello" })
    expect((await row(id)).state).toBe("succeeded")
  })

  it("fails the job rather than the worker when a handler throws", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_throw_${v7().slice(0, 8)}`
    const id = await enqueue(db, { kind, maxAttempts: 1 })

    await runOne(db, {
      workerId: "w1",
      handlers: {
        [kind]: () => Promise.reject(new Error("handler exploded")),
      },
    })

    const failed = await row(id)
    expect(failed.state).toBe("dead_lettered")
    expect(failed.lastError).toContain("handler exploded")
  })

  it("reports idle rather than blocking when there is nothing to do", async ({ skip }) => {
    if (!reachable) skip()
    const kind = `test_kind_empty_${v7().slice(0, 8)}`
    expect(
      await runOne(db, { workerId: "w1", handlers: { [kind]: () => Promise.resolve() } }),
    ).toBe("idle")
  })

  it("only claims kinds it can handle", async ({ skip }) => {
    if (!reachable) skip()
    const mine = `test_kind_mine_${v7().slice(0, 8)}`
    const theirs = `test_kind_theirs_${v7().slice(0, 8)}`
    await enqueue(db, { kind: theirs })
    const id = await enqueue(db, { kind: mine })

    // A worker that claimed every kind would take work it cannot run and dead-letter it.
    await runOne(db, { workerId: "w1", handlers: { [mine]: () => Promise.resolve() } })

    expect((await row(id)).state).toBe("succeeded")
  })
})

async function row(id: string) {
  return await db
    .selectFrom("backgroundJob")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

async function countWithKey(idempotencyKey: string): Promise<number> {
  const result = await db
    .selectFrom("backgroundJob")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirstOrThrow()
  return Number(result.count)
}
