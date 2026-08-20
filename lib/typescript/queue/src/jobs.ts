import { Queue, type JobState } from "bullmq"
import { Redis } from "ioredis"
import { tenantQueuePrefix } from "./prefix"

/**
 * Reading and editing one job in a tenant's queue.
 *
 * BullMQ rather than hand-written RESP: a job is not one key. It is a hash, plus membership in one
 * of several lists and sorted sets that together *are* its state, and `updateData` is a Lua script
 * that respects the lock a worker holds. Reimplementing that from the key layout would be
 * reimplementing the part where being wrong corrupts a customer's queue.
 */

export type QueueLocation = {
  /** The Valkey the tenant's queue lives on. */
  connectionUrl: string
  /** The `backend_service` whose namespace holds it. */
  backendServiceId: string
  /** The queue, as BullMQ names it. */
  queueName: string
}

export type JobSnapshot = {
  id: string
  name: string
  state: JobState | "unknown"
  data: unknown
  attemptsMade: number
  timestamp: number | null
  processedOn: number | null
  finishedOn: number | null
  failedReason: string | null
}

/**
 * States in which a job's data may still be changed.
 *
 * Everything else is refused, for two different reasons:
 *
 * - **`active`** — a worker already holds this payload in memory. Editing the hash would change
 *   what the *next* attempt sees while the attempt already running goes on using the old data, so
 *   the audit row would describe an edit that did not take effect. Silently doing nothing is worse
 *   than saying no.
 * - **`completed` / `failed`** — the job has run. Changing its input afterwards edits the record of
 *   what happened, which is the one thing an audit trail exists to prevent.
 */
export const EDITABLE_STATES: readonly JobState[] = [
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
]

export class JobNotFoundError extends Error {
  override readonly name = "JobNotFoundError"

  constructor(readonly jobId: string) {
    super(`No job ${jobId} in this queue`)
  }
}

export class JobNotEditableError extends Error {
  override readonly name = "JobNotEditableError"

  constructor(
    readonly jobId: string,
    readonly state: string,
  ) {
    super(
      state === "active"
        ? `Job ${jobId} is already running. Editing it now would change what a later attempt sees while the attempt in progress carries on with the old data.`
        : `Job ${jobId} has already finished (${state}). Its data is a record of what ran and cannot be changed.`,
    )
  }
}

/**
 * Opens a connection scoped to one tenant's queue.
 *
 * `maxRetriesPerRequest: null` is BullMQ's requirement for anything that blocks; nothing here does,
 * but the option is set for the same reason BullMQ asks for it — a command that silently gives up
 * after N retries turns a transient blip into a wrong answer.
 */
/**
 * A queue whose payloads are `unknown`.
 *
 * BullMQ's `DataType` defaults to `any`, which would make every `job.data` in this file an
 * unchecked value the compiler waves through. It is a customer's payload — we neither know nor get
 * to assume its shape — so `unknown` is both the honest type and the one that forces a caller to
 * decide what to do with it.
 */
type TenantQueue = Queue<unknown>

async function withQueue<T>(
  location: QueueLocation,
  body: (queue: TenantQueue) => Promise<T>,
): Promise<T> {
  const connection = new Redis(location.connectionUrl, { maxRetriesPerRequest: null })
  const queue: TenantQueue = new Queue(location.queueName, {
    connection,
    prefix: tenantQueuePrefix(location.backendServiceId),
  })

  try {
    return await body(queue)
  } finally {
    // Both, in order. Closing the queue alone leaves the ioredis socket open, and an API process
    // that opens one per request runs out of file descriptors rather than failing anywhere useful.
    await queue.close()
    await connection.quit().catch(() => {
      connection.disconnect()
    })
  }
}

type TenantJob = Awaited<ReturnType<TenantQueue["getJob"]>> & object

function snapshot(job: TenantJob, state: JobState | "unknown"): JobSnapshot {
  return {
    id: job.id ?? "",
    name: job.name,
    state,
    data: job.data,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    failedReason: job.failedReason ?? null,
  }
}

/** Reads one job. Throws `JobNotFoundError` if the queue has no such id. */
export async function readJob(location: QueueLocation, jobId: string): Promise<JobSnapshot> {
  return await withQueue(location, async (queue) => {
    const job = await queue.getJob(jobId)
    if (job === undefined) throw new JobNotFoundError(jobId)
    return snapshot(job, await job.getState())
  })
}

/**
 * Replaces a job's data, returning what it was and what it became.
 *
 * **The before value comes from the same read that checked the state**, so the audit row records
 * the data this edit actually replaced. Reading it in a second call would leave room for the job to
 * change in between, and an audit trail whose "before" is a guess is worse than none.
 *
 * There is still a race: a worker can pick the job up between the state check and the write. BullMQ
 * closes it — `updateData` is a Lua script and a job that moved is no longer where the script looks
 * — but the honest description is that this refuses an edit it can see is unsafe, not that it holds
 * a lock.
 */
export async function updateJobData(
  location: QueueLocation,
  jobId: string,
  data: unknown,
): Promise<{ before: unknown; after: unknown; state: JobState | "unknown" }> {
  return await withQueue(location, async (queue) => {
    const job = await queue.getJob(jobId)
    if (job === undefined) throw new JobNotFoundError(jobId)

    const state = await job.getState()
    if (!EDITABLE_STATES.includes(state as JobState)) {
      throw new JobNotEditableError(jobId, state)
    }

    const before = job.data
    await job.updateData(data)
    return { before, after: data, state }
  })
}
