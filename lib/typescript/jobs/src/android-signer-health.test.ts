import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import {
  ANDROID_SIGNER_METRIC_NAMESPACE,
  recordAndroidSignerHeartbeat,
  sampleAndroidSignerHealth,
  sampleAndroidSignerHealthJob,
} from "./android-signer-health"

let reachable = false
const signerId = `health-test-${v7()}`

beforeAll(async () => {
  try {
    await sql`select 1 from android_signer_instance limit 1`.execute(db)
    reachable = true
  } catch {
    return
  }
})

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("androidSignerInstance").where("signerId", "=", signerId).execute()
  await db.destroy()
})

describe("Android signer fleet health", () => {
  it("uses a durable poll heartbeat and publishes the alarm contract", async ({ skip }) => {
    if (!reachable) skip()
    const seenAt = new Date("2098-12-31T23:59:30.000Z")
    const sampledAt = new Date("2099-01-01T00:00:00.000Z")
    await recordAndroidSignerHeartbeat(db, signerId, seenAt)

    const sample = await sampleAndroidSignerHealth(db, sampledAt)
    expect(sample).toEqual({
      heartbeatAgeSeconds: 30,
      oldestQueuedJobAgeSeconds: 0,
      failedJobs: 0,
    })

    const published: unknown[] = []
    await sampleAndroidSignerHealthJob(
      (value, at) => {
        published.push({ namespace: ANDROID_SIGNER_METRIC_NAMESPACE, value, at })
        return Promise.resolve()
      },
      () => sampledAt,
    )(
      {
        id: v7(),
        kind: "android.signer_health",
        payload: { window: "2099-01-01T00:00" },
        attempt: 1,
        maxAttempts: 1,
        organizationId: null,
      },
      { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal },
    )
    expect(published).toEqual([
      { namespace: ANDROID_SIGNER_METRIC_NAMESPACE, value: sample, at: sampledAt },
    ])
  })
})
