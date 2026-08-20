import { Queue, Worker } from "bullmq"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import {
  EDITABLE_STATES,
  JobNotEditableError,
  JobNotFoundError,
  readJob,
  updateJobData,
  type QueueLocation,
} from "./jobs"
import { tenantQueuePrefix } from "./prefix"

/**
 * Runs against the compose Valkey with a real BullMQ producer.
 *
 * The thing being tested is agreement with BullMQ's key layout and its notion of job state — which
 * is BullMQ's to define, not ours. A mock would assert my reading of its source, which is exactly
 * the assumption most likely to be wrong.
 */
const CONNECTION = process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://127.0.0.1:41023"

/**
 * On a developer's machine an absent Valkey is a skip: `pnpm test` should not fail because docker
 * is not running. **In CI it throws** — a skipped test looks exactly like a passing one in the
 * summary, so a workflow that lost its service container would go on reporting green while the
 * tests that check one tenant cannot read another's jobs had stopped running.
 */
const reachable = await (async () => {
  const probe = new Redis(CONNECTION, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  })

  let up = false
  try {
    await probe.connect()
    await probe.ping()
    up = true
  } catch {
    up = false
  } finally {
    probe.disconnect()
  }

  if (!up && process.env.CI !== undefined) {
    throw new Error(
      `The Valkey at ${CONNECTION} is not reachable in CI; these tests must not skip here.`,
    )
  }
  return up
})()

// A fresh backend-service id per run, so these tests never collide with each other or with a
// developer's own data on the shared instance.
const backendServiceId = v7()
const location: QueueLocation = {
  connectionUrl: CONNECTION,
  backendServiceId,
  queueName: "emails",
}

let producer: Queue | undefined
let connection: Redis | undefined

beforeAll(() => {
  if (!reachable) return
  connection = new Redis(CONNECTION, { maxRetriesPerRequest: null })
  // The producer stands in for the tenant's own worker code: same queue name, same prefix.
  producer = new Queue("emails", {
    connection,
    prefix: tenantQueuePrefix(backendServiceId),
  })
})

/*
  `skip()` inside a test does not narrow a type, so reaching for the producer through these keeps
  the checker honest without an assertion operator in every test. They cannot actually throw: the
  suite is skipped wholesale when the services are unreachable, which is the only path that leaves
  them unset.
*/
function activeProducer(): Queue {
  if (producer === undefined) throw new Error("the producer was not started")
  return producer
}

function activeConnection(): Redis {
  if (connection === undefined) throw new Error("the connection was not opened")
  return connection
}

afterAll(async () => {
  if (!reachable) return
  await producer?.obliterate({ force: true }).catch(() => undefined)
  await producer?.close()
  await connection?.quit().catch(() => connection?.disconnect())
})

describe.skipIf(!reachable)("job inspection and editing", () => {
  it("reads a job a real BullMQ producer enqueued", async ({ skip }) => {
    if (!reachable) skip()
    const job = await activeProducer().add("send", { to: "someone@example.com", subject: "Hi" })

    const snapshot = await readJob(location, job.id ?? "")
    expect(snapshot.name).toBe("send")
    expect(snapshot.data).toEqual({ to: "someone@example.com", subject: "Hi" })
    expect(EDITABLE_STATES).toContain(snapshot.state)
    expect(snapshot.timestamp).toBeGreaterThan(0)
  })

  it("writes the key where the proxy's namespace puts it", async ({ skip }) => {
    if (!reachable) skip()
    const job = await activeProducer().add("send", { to: "keys@example.com" })

    /*
      The agreement that matters. A tenant's worker reaches this key as `bull:emails:<id>` because
      the proxy prepends the namespace; the control plane connects directly and must prepend both
      halves itself. If the two ever disagree the API edits a job nobody is going to run.
    */
    const key = `${tenantQueuePrefix(backendServiceId)}:emails:${job.id}`
    expect(await activeConnection().exists(key)).toBe(1)
    expect(key.startsWith("{kv:")).toBe(true)

    // And nothing was written outside the namespace.
    expect(await activeConnection().exists(`bull:emails:${job.id}`)).toBe(0)
  })

  it("edits a waiting job and reports what it replaced", async ({ skip }) => {
    if (!reachable) skip()
    const job = await activeProducer().add("send", { to: "before@example.com", retries: 0 })

    const result = await updateJobData(location, job.id ?? "", { to: "after@example.com" })
    expect(result.before).toEqual({ to: "before@example.com", retries: 0 })
    expect(result.after).toEqual({ to: "after@example.com" })

    // Read back through a fresh connection: the edit has to be in Valkey, not just in our object.
    expect((await readJob(location, job.id ?? "")).data).toEqual({ to: "after@example.com" })
  })

  it("refuses to edit a job that has already finished", async ({ skip }) => {
    if (!reachable) skip()
    const job = await activeProducer().add("send", { to: "done@example.com" })

    /*
      Driven to completion by a real Worker rather than by writing the state by hand.

      `moveToCompleted` needs the job to be active and to hold the lock, which is the whole reason
      an edit is refused at that point — so faking the transition would test the refusal against a
      state BullMQ never actually produces.
    */
    const worker = new Worker("emails", () => Promise.resolve("ok"), {
      connection: new Redis(CONNECTION, { maxRetriesPerRequest: null }),
      prefix: tenantQueuePrefix(backendServiceId),
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("the worker never finished the job"))
        }, 10_000)
        worker.on("completed", (finished) => {
          if (finished.id !== job.id) return
          clearTimeout(timer)
          resolve()
        })
        worker.on("failed", (_, error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
    } finally {
      await worker.close()
    }

    expect(await job.getState()).toBe("completed")
    await expect(updateJobData(location, job.id ?? "", { to: "x" })).rejects.toThrow(
      JobNotEditableError,
    )
  })

  it("refuses a job that is not in this queue", async ({ skip }) => {
    if (!reachable) skip()
    await expect(readJob(location, "no-such-job")).rejects.toThrow(JobNotFoundError)
    await expect(updateJobData(location, "no-such-job", {})).rejects.toThrow(JobNotFoundError)
  })

  it("cannot see another tenant's job", async ({ skip }) => {
    if (!reachable) skip()
    const job = await activeProducer().add("send", { to: "mine@example.com" })

    // Same queue name, same Valkey, different backend service. The namespace is the only thing
    // separating them, so this is the isolation assertion for the control-plane side.
    const other: QueueLocation = { ...location, backendServiceId: v7() }
    await expect(readJob(other, job.id ?? "")).rejects.toThrow(JobNotFoundError)
  })
})
