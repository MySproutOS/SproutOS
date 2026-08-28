import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import { publishQueue, readQueue, setQueueTarget, withdrawQueue } from "./queues"

const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
})
const reachable = await (async () => {
  try {
    await valkey.connect()
    return (await valkey.ping()) === "PONG"
  } catch {
    return false
  }
})()

afterAll(() => {
  valkey.disconnect()
})

describe.runIf(reachable)("queue binding lifecycle", () => {
  it("moves the function target without changing the one-time credential", async () => {
    const resource = `queue-test-${crypto.randomUUID()}`
    const original = {
      uri: "rediss://tenant:one-time-secret@queue.example.test:6379/0",
      backendServiceId: crypto.randomUUID(),
      projectId: "project-one",
      organizationId: crypto.randomUUID(),
    }
    await publishQueue(valkey, resource, original)

    expect(
      await setQueueTarget(
        valkey,
        resource,
        "project-one",
        "arn:aws:lambda:us-east-1:123:function:app:live",
      ),
    ).toBe(true)
    expect(await readQueue(valkey, resource)).toEqual({
      ...original,
      functionArn: "arn:aws:lambda:us-east-1:123:function:app:live",
    })

    expect(await setQueueTarget(valkey, resource, "project-one", null)).toBe(true)
    expect(await readQueue(valkey, resource)).toEqual({
      ...original,
      projectId: "project-one",
    })
    await withdrawQueue(valkey, resource)
    await valkey.del(`queue:deleted:${resource}`)
  })

  it("never resurrects a binding teardown already withdrew", async () => {
    const resource = `queue-test-${crypto.randomUUID()}`
    await publishQueue(valkey, resource, {
      uri: "rediss://tenant:secret@queue.example.test:6379/0",
      backendServiceId: crypto.randomUUID(),
      projectId: null,
      organizationId: crypto.randomUUID(),
    })
    await withdrawQueue(valkey, resource)

    expect(await setQueueTarget(valkey, resource, "deleted-project", "arn:deleted")).toBe(false)
    expect(await readQueue(valkey, resource)).toBeUndefined()

    // Force the dangerous race ordering deterministically: deletion commits its withdrawal while
    // a credential rotation that began earlier returns from the provider afterward.
    expect(
      await publishQueue(valkey, resource, {
        uri: "rediss://tenant:late-rotated-secret@queue.example.test:6379/0",
        backendServiceId: crypto.randomUUID(),
        projectId: "deleted-project",
        organizationId: crypto.randomUUID(),
      }),
    ).toBe(false)
    expect(await readQueue(valkey, resource)).toBeUndefined()

    // A pre-rollout API replica still uses unconditional SET. Its late write cannot overwrite the
    // separate fence, cannot become executable, and is invisible to every new reader.
    await valkey.set(
      `queue:${resource}`,
      JSON.stringify({
        uri: "rediss://tenant:old-replica-secret@queue.example.test:6379/0",
        backendServiceId: crypto.randomUUID(),
        projectId: null,
        organizationId: crypto.randomUUID(),
      }),
    )
    expect(await readQueue(valkey, resource)).toBeUndefined()
    expect(await setQueueTarget(valkey, resource, "deleted-project", "arn:deleted")).toBe(false)

    await valkey.del(`queue:${resource}`, `queue:deleted:${resource}`)
  })
})
