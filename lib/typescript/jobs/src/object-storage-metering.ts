/* oxlint-disable no-await-in-loop -- each S3 page and service watermark is deliberately serial */
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3"
import { crudMeteringOutbox } from "@lib/dao"
import { encodeUsageEvent, usageEventRecord } from "@lib/metering"
import { bucketNameFor } from "@lib/services"
import type { DB, JsonValue } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import type { JobHandler } from "./worker"

export const METER_OBJECT_STORAGE_KIND = "billing.meter_object_storage"
export const OBJECT_STORAGE_RETENTION_SECONDS = 48 * 60 * 60

type Candidate = {
  backendServiceId: string
  organizationId: string
  projectId: string | null
  currentBytes: string | null
  meteredThrough: Date | null
}

type VersionLister = {
  send(command: ListObjectVersionsCommand): Promise<{
    Versions?: Array<{ Size?: number }>
    IsTruncated?: boolean
    NextKeyMarker?: string
    NextVersionIdMarker?: string
  }>
}

function nextMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
}

function scaledDecimal(value: bigint): string {
  const whole = value / 1_000_000_000n
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`
}

/**
 * Convert byte-seconds to AWS's GB-month quantity, using the actual hours in each UTC month.
 *
 * AWS defines one billed GB-month as accumulated GB-hours divided by the hours in that month. An
 * interval crossing a month boundary therefore has two denominators and must be split rather than
 * treated as a fixed 730- or 744-hour month.
 */
export function objectStorageGbMonthSegments(
  bytes: bigint,
  from: Date,
  to: Date,
): Array<{ from: Date; to: Date; quantity: string }> {
  if (bytes < 0n) throw new RangeError("Object-storage bytes cannot be negative")
  if (from >= to || bytes === 0n) return []

  const segments: Array<{ from: Date; to: Date; quantity: string }> = []
  for (let cursor = from; cursor < to;) {
    const monthEnd = nextMonth(cursor)
    const end = monthEnd < to ? monthEnd : to
    const monthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1))
    const monthSeconds = BigInt((nextMonth(monthStart).getTime() - monthStart.getTime()) / 1000)
    const seconds = BigInt((end.getTime() - cursor.getTime()) / 1000)
    // A decimal quantity carries nine fractional digits. The 10^9 quantity scale cancels the
    // decimal-GB divisor, leaving an exact and overflow-safe integer expression.
    const scaled = (bytes * seconds) / monthSeconds
    if (scaled > 0n) segments.push({ from: cursor, to: end, quantity: scaledDecimal(scaled) })
    cursor = end
  }
  return segments
}

/** Cost, rounded up, of retaining `bytes` for another forty-eight hours at `rateMicroUsd`. */
export function objectStorageReserveMicroUsd(
  bytes: bigint,
  rateMicroUsd: bigint,
  at: Date,
): bigint {
  if (bytes <= 0n || rateMicroUsd <= 0n) return 0n
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const monthSeconds = BigInt((nextMonth(monthStart).getTime() - monthStart.getTime()) / 1000)
  const numerator = bytes * rateMicroUsd * BigInt(OBJECT_STORAGE_RETENTION_SECONDS)
  const denominator = 1_000_000_000n * monthSeconds
  return (numerator + denominator - 1n) / denominator
}

/** Count every retained version: versioning makes old versions billable even after a normal delete. */
export async function retainedObjectBytes(
  s3: VersionLister,
  bucket: string,
  prefix: string,
): Promise<bigint> {
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  let bytes = 0n

  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 1000,
      }),
    )
    for (const version of page.Versions ?? []) {
      if (version.Size !== undefined) bytes += BigInt(version.Size)
    }
    if (page.IsTruncated !== true) return bytes
    if (page.NextKeyMarker === undefined) {
      throw new Error(`S3 truncated ${prefix} without a continuation marker`)
    }
    keyMarker = page.NextKeyMarker
    versionIdMarker = page.NextVersionIdMarker
  }
}

async function candidates(db: Kysely<DB>, backendServiceId?: string): Promise<Candidate[]> {
  let query = db
    .selectFrom("backendService")
    .leftJoin(
      "objectStorageMeteringState",
      "objectStorageMeteringState.backendServiceId",
      "backendService.id",
    )
    .select([
      "backendService.id as backendServiceId",
      "backendService.organizationId",
      "backendService.projectId",
      "objectStorageMeteringState.currentBytes",
      "objectStorageMeteringState.meteredThrough",
    ])
    .where("backendService.kind", "=", "object_storage")
    .where("backendService.deletedAt", "is", null)
    // Suspended data is exactly what the retention reserve exists to keep metering.
    .where("backendService.status", "in", ["active", "suspended"])
    .orderBy("backendService.id")
  if (backendServiceId !== undefined) {
    query = query.where("backendService.id", "=", backendServiceId)
  }
  return await query.execute()
}

export type ObjectStorageMeteringOptions = {
  now?: Date
  s3?: VersionLister
  sharedBucket?: string
  /** Narrow deterministic integration tests without changing the production all-service sweep. */
  backendServiceId?: string
}

/** Sample retained S3 versions and emit only the interval bracketed by two successful samples. */
export async function meterObjectStorage(
  db: Kysely<DB>,
  options: ObjectStorageMeteringOptions = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const sharedBucket =
    options.sharedBucket ?? process.env.SERVICE_OBJECT_STORAGE_SHARED_BUCKET ?? ""
  if (sharedBucket === "") {
    throw new Error("SERVICE_OBJECT_STORAGE_SHARED_BUCKET is not set; storage cannot be metered")
  }
  const s3 = options.s3 ?? new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" })
  let emitted = 0

  for (const candidate of await candidates(db, options.backendServiceId)) {
    const prefix = `${bucketNameFor(candidate.backendServiceId)}/`
    const measuredBytes = await retainedObjectBytes(s3, sharedBucket, prefix)

    emitted += await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom("backendService")
        .select("id")
        .where("id", "=", candidate.backendServiceId)
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst()
      if (locked === undefined) return 0

      const state = await trx
        .selectFrom("objectStorageMeteringState")
        .select(["currentBytes", "meteredThrough"])
        .where("backendServiceId", "=", candidate.backendServiceId)
        .executeTakeFirst()
      const outbox = crudMeteringOutbox(trx)
      let count = 0
      if (state?.meteredThrough !== null && state?.meteredThrough !== undefined) {
        for (const segment of objectStorageGbMonthSegments(
          BigInt(state.currentBytes),
          state.meteredThrough,
          now,
        )) {
          const event = usageEventRecord({
            source: "s3-version-inventory",
            externalId: `${candidate.backendServiceId}:object_storage_gb_month:${segment.from.toISOString()}:${segment.to.toISOString()}`,
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
            resourceType: "object_storage",
            resourceId: candidate.backendServiceId,
            dimension: "object_storage_gb_month",
            quantity: segment.quantity,
            occurredAt: segment.to,
            windowStart: segment.from,
            windowEnd: segment.to,
            nodeId: null,
            podUid: null,
            chargedExternally: false,
            attributes: {
              provider: "aws_s3",
              physical_bucket: sharedBucket,
              retained_bytes: state.currentBytes,
              conversion: "byte_seconds/decimal_gb/utc_month_seconds",
            },
          })
          await outbox.create({
            id: v7(),
            eventId: event.eventId,
            payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
          })
          count++
        }
      }

      await trx
        .insertInto("objectStorageMeteringState")
        .values({
          backendServiceId: candidate.backendServiceId,
          currentBytes: measuredBytes,
          measuredAt: now,
          meteredThrough: now,
        })
        .onConflict((conflict) =>
          conflict.column("backendServiceId").doUpdateSet({
            currentBytes: measuredBytes,
            measuredAt: now,
            meteredThrough: now,
            updatedAt: new Date(),
          }),
        )
        .execute()
      return count
    })
  }

  return emitted
}

export function meterObjectStorageJob(): JobHandler {
  return async (_job, { db }) => {
    const emitted = await meterObjectStorage(db)
    if (emitted > 0) console.info(`[jobs] metered ${emitted} object-storage interval(s)`)
  }
}
