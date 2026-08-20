import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { claim, fail, heartbeat, type Job, reclaimExpired, succeed } from "./queue"

export type JobHandler = (job: Job, context: JobContext) => Promise<void>

export type JobContext = {
  db: Kysely<DB>
  /** Extend the lease from inside a long job. Returns false once the lease has been taken away. */
  keepAlive: () => Promise<boolean>
  signal: AbortSignal
}

export type WorkerOptions = {
  workerId: string
  handlers: Record<string, JobHandler>
  /** How long a claimed job may run before the lease expires and it is reclaimed. */
  leaseSeconds?: number
  /** How many jobs to hold at once. One by default: most handlers here are not cheap. */
  concurrency?: number
  /** How long to wait when the queue came back empty. */
  idleMs?: number
  signal?: AbortSignal
  onEvent?: (event: WorkerEvent) => void
}

export type WorkerEvent =
  | { type: "claimed"; job: Job }
  | { type: "succeeded"; job: Job }
  | { type: "failed"; job: Job; outcome: "retrying" | "dead_lettered"; error: unknown }
  | { type: "reclaimed"; count: number }
  | { type: "unhandled"; job: Job }

/**
 * Run one job. Exposed on its own so a `run-now` HTTP trigger can drive exactly one, which is what
 * makes local development bearable — otherwise every job type needs a poller running to be tested.
 */
export async function runOne(db: Kysely<DB>, options: WorkerOptions): Promise<"ran" | "idle"> {
  const [job] = await claim(db, options.workerId, {
    kinds: Object.keys(options.handlers),
    limit: 1,
    leaseSeconds: options.leaseSeconds ?? 300,
  })
  if (job === undefined) return "idle"

  options.onEvent?.({ type: "claimed", job })
  const handler = options.handlers[job.kind]

  if (handler === undefined) {
    // Claimed by kind, so this can only happen if the handler map changed under us mid-poll.
    // Failing it is better than leaving it `running` until the lease expires.
    options.onEvent?.({ type: "unhandled", job })
    await fail(db, job, new Error(`No handler registered for job kind "${job.kind}"`))
    return "ran"
  }

  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }
  options.signal?.addEventListener("abort", abort, { once: true })

  try {
    await handler(job, {
      db,
      keepAlive: () => heartbeat(db, job.id, options.workerId, options.leaseSeconds ?? 300),
      signal: controller.signal,
    })
    await succeed(db, job.id)
    options.onEvent?.({ type: "succeeded", job })
  } catch (error) {
    const outcome = await fail(db, job, error)
    options.onEvent?.({ type: "failed", job, outcome, error })
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }

  return "ran"
}

/**
 * Poll until the signal aborts.
 *
 * Deliberately a plain loop rather than a scheduler. Nine independent schedulers were proposed
 * during design and every one of them was a job type in disguise; retention sweeps, fork upkeep,
 * hold expiry, and usage rating all enqueue rows into the same table and are claimed by the same
 * loop. A second scheduling mechanism is a second place for work to get stuck.
 */
export async function work(db: Kysely<DB>, options: WorkerOptions): Promise<void> {
  const idleMs = options.idleMs ?? 1000
  const signal = options.signal

  while (signal?.aborted !== true) {
    const reclaimed = await reclaimExpired(db)
    if (reclaimed > 0) options.onEvent?.({ type: "reclaimed", count: reclaimed })

    const results = await Promise.all(
      Array.from({ length: options.concurrency ?? 1 }, () => runOne(db, options)),
    )

    // Only sleep when there was nothing at all. A partially busy poll means more work is waiting.
    if (results.every((result) => result === "idle")) {
      await sleep(idleMs, signal)
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
