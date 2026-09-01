import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch"
import { crudAndroidSignerInstance, fetchAndroidSignerInstance } from "@lib/dao"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import type { JobHandler } from "./worker"

export const ANDROID_SIGNER_HEALTH_KIND = "android.signer_health"
export const ANDROID_SIGNER_METRIC_NAMESPACE = "SproutOS/AndroidSigner"

export async function recordAndroidSignerHeartbeat(
  db: Kysely<DB>,
  signerId: string,
  at: Date = new Date(),
): Promise<void> {
  await crudAndroidSignerInstance(db).touch(signerId, at)
}

export type AndroidSignerHealth = {
  heartbeatAgeSeconds?: number
  oldestQueuedJobAgeSeconds: number
  failedJobs: number
}

export async function sampleAndroidSignerHealth(
  db: Kysely<DB>,
  now: Date = new Date(),
  failureWindow: { start: Date; end: Date } = {
    start: new Date(now.getTime() - 60_000),
    end: now,
  },
): Promise<AndroidSignerHealth> {
  const latest = await fetchAndroidSignerInstance(db).latest(["lastSeenAt"])
  const queued = await sql<{ oldest: Date | null }>`
    select min(created_at) as oldest
    from (
      select created_at from android_signer_job where state = 'queued'
      union all
      select created_at from client_signer_job where state = 'queued'
    ) queued_jobs
  `.execute(db)
  const failures = await sql<{ count: string }>`
    select count(*)::text as count
    from (
      select updated_at from android_signer_job where state = 'failed'
      union all
      select updated_at from client_signer_job where state = 'failed'
    ) failed_jobs
    where updated_at >= ${failureWindow.start}
      and updated_at < ${failureWindow.end}
  `.execute(db)
  const oldest = queued.rows[0]?.oldest
  return {
    ...(latest === undefined
      ? {}
      : { heartbeatAgeSeconds: Math.max(0, (now.getTime() - latest.lastSeenAt.getTime()) / 1000) }),
    oldestQueuedJobAgeSeconds:
      oldest === null || oldest === undefined
        ? 0
        : Math.max(0, (now.getTime() - oldest.getTime()) / 1000),
    failedJobs: Number(failures.rows[0]?.count ?? 0),
  }
}

export type AndroidSignerMetricPublisher = (sample: AndroidSignerHealth, at: Date) => Promise<void>

export function publishAndroidSignerMetrics(): AndroidSignerMetricPublisher {
  return async (sample, at) => {
    const client = new CloudWatchClient({})
    try {
      await client.send(
        new PutMetricDataCommand({
          Namespace: ANDROID_SIGNER_METRIC_NAMESPACE,
          MetricData: [
            ...(sample.heartbeatAgeSeconds === undefined
              ? []
              : [
                  {
                    MetricName: "SignerHeartbeatAgeSeconds",
                    Unit: "Seconds" as const,
                    Value: sample.heartbeatAgeSeconds,
                    Timestamp: at,
                  },
                ]),
            {
              MetricName: "OldestQueuedJobAgeSeconds",
              Unit: "Seconds",
              Value: sample.oldestQueuedJobAgeSeconds,
              Timestamp: at,
            },
            {
              MetricName: "FailedJobs",
              Unit: "Count",
              Value: sample.failedJobs,
              Timestamp: at,
            },
          ],
        }),
      )
    } finally {
      client.destroy()
    }
  }
}

export function sampleAndroidSignerHealthJob(
  publish: AndroidSignerMetricPublisher = publishAndroidSignerMetrics(),
  now: () => Date = () => new Date(),
): JobHandler {
  return async (job, { db }) => {
    const at = now()
    const window =
      typeof job.payload === "object" &&
      job.payload !== null &&
      "window" in job.payload &&
      typeof job.payload.window === "string"
        ? job.payload.window
        : undefined
    if (window === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(window)) {
      throw new Error("Android signer health job is missing its UTC minute window")
    }
    const start = new Date(`${window}:00.000Z`)
    const end = new Date(start.getTime() + 60_000)
    await publish(await sampleAndroidSignerHealth(db, at, { start, end }), at)
  }
}
