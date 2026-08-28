/* oxlint-disable no-await-in-loop -- S3 pages and bounded outbox batches are intentionally ordered */
import {
  GetObjectCommand,
  type GetObjectCommandInput,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  S3Client,
} from "@aws-sdk/client-s3"
import {
  crudMeteringImportState,
  crudMeteringOutbox,
  crudProviderUsageReconciliation,
  fetchMeteringImportState,
} from "@lib/dao"
import { encodeUsageEvent, usageEventRecord, type UsageEventRecord } from "@lib/metering"
import { staticCloudFrontUsageTotals, type StaticCloudFrontUsageTotals } from "@lib/observability"
import type { DB, JsonValue } from "@sproutos/db"
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch"
import { createHash } from "node:crypto"
import { gunzip as gunzipCallback } from "node:zlib"
import { promisify } from "node:util"
import { type Kysely } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

export const STATIC_CLOUDFRONT_METERING_KINDS = {
  scan: "billing.scan_static_cloudfront_logs",
  importObject: "billing.import_static_cloudfront_log",
  reconcile: "billing.reconcile_static_cloudfront_usage",
} as const

export const STATIC_CLOUDFRONT_LOG_PREFIX = "tenant-static/"
export const STATIC_CLOUDFRONT_RETENTION_DAYS = 90
export const STATIC_CLOUDFRONT_LATE_DELIVERY_OVERLAP_DAYS = 2
export const STATIC_CLOUDFRONT_OUTBOX_BATCH_SIZE = 500
export const STATIC_CLOUDFRONT_IMPORT_CONSUMER = "static-cloudfront-standard-v2"
export const STATIC_CLOUDFRONT_RECONCILIATION_DAYS = 3
export const STATIC_CLOUDFRONT_DELIVERY_GRACE_HOURS = 48
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024
const SOURCE = "cloudfront-standard-v2"
const gunzip = promisify(gunzipCallback)

type Attribution = {
  deploymentId: string
  organizationId: string
  projectId: string
}

type StaticLogConfig = {
  bucket: string
  prefix: string
}

type ScanDependencies = {
  now?: () => Date
  list?: (input: ListObjectsV2CommandInput) => Promise<{
    Contents?: { Key?: string; ETag?: string }[]
    IsTruncated?: boolean
    NextContinuationToken?: string
  }>
  enqueueObject?: (
    db: Kysely<DB>,
    input: { key: string; etag: string; idempotencyKey: string },
  ) => Promise<void>
  loadCursor?: (db: Kysely<DB>) => Promise<Date | undefined>
  advanceCursor?: (db: Kysely<DB>, cursor: Date) => Promise<void>
  config?: StaticLogConfig
}

type ImportDependencies = {
  get?: (input: GetObjectCommandInput) => Promise<{ Body?: unknown }>
  resolveAttribution?: (
    db: Kysely<DB>,
    requests: ParsedRequest[],
  ) => Promise<Map<string, Attribution>>
  storeEvents?: (db: Kysely<DB>, events: UsageEventRecord[]) => Promise<void>
  config?: StaticLogConfig
}

type ReconciliationTotals = {
  requests: string
}

type ReconciliationDependencies = {
  now?: () => Date
  providerTotals?: (start: Date, end: Date) => Promise<ReconciliationTotals>
  importedTotals?: (start: Date, end: Date) => Promise<StaticCloudFrontUsageTotals>
  store?: (
    db: Kysely<DB>,
    input: {
      importedRequests: string
      observedAt: Date
      periodStart: Date
      providerRequests: string
      residualRequests: string
      resourceId: string
      status: "matched" | "pending_delivery" | "platform_overhead"
    },
  ) => Promise<void>
  distributionId?: string
}

type ParsedRequest = {
  bytes: string
  hostname: string
  occurredAt: Date
  requestId: string
  routePrefix: string | null
}

function configFromEnv(): StaticLogConfig {
  const bucket = process.env.TENANT_STATIC_LOG_BUCKET
  if (bucket === undefined || bucket === "") {
    throw new Error(
      "TENANT_STATIC_LOG_BUCKET is not set; static CloudFront usage cannot be imported",
    )
  }
  const prefix = process.env.TENANT_STATIC_LOG_PREFIX ?? STATIC_CLOUDFRONT_LOG_PREFIX
  if (prefix === "" || !prefix.endsWith("/") || prefix.startsWith("/")) {
    throw new Error("TENANT_STATIC_LOG_PREFIX must be a non-empty relative prefix ending in '/'")
  }
  return { bucket, prefix }
}

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
  })
}

function dayPrefix(prefix: string, value: Date): string {
  return `${prefix}${value.toISOString().slice(0, 10).replaceAll("-", "/")}/`
}

function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

export function staticCloudFrontObjectIdempotencyKey(input: {
  bucket: string
  key: string
  etag: string
}): string {
  const digest = createHash("sha256")
  for (const part of [input.bucket, input.key, input.etag]) {
    digest.update(String(Buffer.byteLength(part, "utf8")))
    digest.update(":")
    digest.update(part)
  }
  return `${STATIC_CLOUDFRONT_METERING_KINDS.importObject}:${digest.digest("hex")}`
}

/**
 * Discover new immutable log objects from the durable consumer cursor through scan start.
 * Per-object queue keys make the late-delivery overlap and every failure retry safe.
 */
export function scanStaticCloudFrontLogs(dependencies: ScanDependencies = {}): JobHandler {
  let client: S3Client | undefined
  const list =
    dependencies.list ??
    (async (input) => {
      client ??= s3Client()
      return await client.send(new ListObjectsV2Command(input))
    })
  const enqueueObject =
    dependencies.enqueueObject ??
    (async (db, input) => {
      await enqueue(db, {
        kind: STATIC_CLOUDFRONT_METERING_KINDS.importObject,
        payload: { key: input.key, etag: input.etag },
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 10,
      })
    })
  const loadCursor =
    dependencies.loadCursor ??
    (async (db) => await fetchMeteringImportState(db).cursor(STATIC_CLOUDFRONT_IMPORT_CONSUMER))
  const advanceCursor =
    dependencies.advanceCursor ??
    (async (db, cursor) => {
      await crudMeteringImportState(db).advanceCursor(STATIC_CLOUDFRONT_IMPORT_CONSUMER, cursor)
    })

  return async (_job, { db, keepAlive, signal }) => {
    const config = dependencies.config ?? configFromEnv()
    const scanStart = dependencies.now?.() ?? new Date()
    if (Number.isNaN(scanStart.getTime())) throw new Error("Static log scan clock is invalid")
    const storedCursor = await loadCursor(db)
    if (storedCursor !== undefined && Number.isNaN(storedCursor.getTime())) {
      throw new Error("Static CloudFront import cursor is invalid")
    }
    const cursor =
      storedCursor === undefined
        ? new Date(scanStart.getTime() - STATIC_CLOUDFRONT_RETENTION_DAYS * 86_400_000)
        : new Date(
            Math.min(storedCursor.getTime(), scanStart.getTime()) -
              STATIC_CLOUDFRONT_LATE_DELIVERY_OVERLAP_DAYS * 86_400_000,
          )
    const firstDay = utcDay(cursor)
    const lastDay = utcDay(scanStart)
    let discovered = 0

    for (
      let date = firstDay;
      date.getTime() <= lastDay.getTime();
      date = new Date(date.getTime() + 86_400_000)
    ) {
      let continuationToken: string | undefined
      do {
        if (signal.aborted) throw signal.reason ?? new Error("Static log scan aborted")
        const page = await list({
          Bucket: config.bucket,
          Prefix: dayPrefix(config.prefix, date),
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        })
        for (const object of page.Contents ?? []) {
          if (object.Key === undefined || object.ETag === undefined || object.Key.endsWith("/")) {
            continue
          }
          const idempotencyKey = staticCloudFrontObjectIdempotencyKey({
            bucket: config.bucket,
            key: object.Key,
            etag: object.ETag,
          })
          await enqueueObject(db, { key: object.Key, etag: object.ETag, idempotencyKey })
          discovered++
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
        if (page.IsTruncated && continuationToken === undefined) {
          throw new Error("S3 truncated a static log listing without a continuation token")
        }
        if (!(await keepAlive())) throw new Error("Static log scan lost its job lease")
      } while (continuationToken !== undefined)
    }

    // This is deliberately last. A failed listing or enqueue leaves the old cursor in place, and
    // the next run rediscovers the whole incomplete range. Per-object queue keys absorb repeats.
    if (signal.aborted) throw signal.reason ?? new Error("Static log scan aborted")
    await advanceCursor(db, scanStart)

    if (discovered > 0)
      console.info(`[jobs] discovered ${discovered} static CloudFront log object(s)`)
  }
}

/** Parse the selected standard-v2 W3C fields without relying on their configured order. */
export function parseStaticCloudFrontLog(contents: string): ParsedRequest[] {
  let fields: string[] | undefined
  const records: ParsedRequest[] = []
  const lines = contents.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (line === "") continue
    if (line.startsWith("#Fields:")) {
      fields = line.slice("#Fields:".length).trim().split(/\s+/)
      continue
    }
    if (line.startsWith("#")) continue
    if (fields === undefined) {
      throw new Error(`Static CloudFront log line ${index + 1} precedes its #Fields header`)
    }

    const values = line.split("\t")
    if (values.length !== fields.length) {
      throw new Error(
        `Static CloudFront log line ${index + 1} has ${values.length} values for ${fields.length} fields`,
      )
    }
    const value = (name: string): string => {
      const position = fields!.indexOf(name)
      if (position === -1) throw new Error(`Static CloudFront log is missing ${name}`)
      return values[position] ?? ""
    }
    const optionalValue = (name: string): string | undefined => {
      const position = fields!.indexOf(name)
      return position === -1 ? undefined : values[position]
    }

    const requestId = value("x-edge-request-id")
    const hostname = normalizedHostname(value("x-host-header"))
    const bytes = value("sc-bytes")
    const encodedRoutePrefix = optionalValue("viewer-request-log-data")
    const routePrefix =
      encodedRoutePrefix === undefined || encodedRoutePrefix === "-"
        ? null
        : normalizedRoutePrefix(encodedRoutePrefix)
    if (requestId === "" || requestId === "-") {
      throw new Error(`Static CloudFront log line ${index + 1} has no request id`)
    }
    if (!/^\d+$/.test(bytes)) {
      throw new Error(
        `Static CloudFront log line ${index + 1} has invalid sc-bytes ${JSON.stringify(bytes)}`,
      )
    }

    const timestampMs = value("timestamp(ms)")
    const timestamp = /^\d+$/.test(timestampMs) ? Number(timestampMs) : Number.NaN
    const occurredAt = Number.isSafeInteger(timestamp)
      ? new Date(timestamp)
      : new Date(`${value("date")}T${value("time")}Z`)
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error(`Static CloudFront log line ${index + 1} has an invalid observed timestamp`)
    }
    records.push({ bytes, hostname, occurredAt, requestId, routePrefix })
  }

  if (fields === undefined) throw new Error("Static CloudFront log has no #Fields header")
  return records
}

function normalizedRoutePrefix(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value).toLowerCase()
  } catch {
    throw new Error(
      `Static CloudFront log has invalid viewer-request-log-data ${JSON.stringify(value)}`,
    )
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}$/.test(
      decoded,
    )
  ) {
    throw new Error(
      `Static CloudFront log has invalid route attribution ${JSON.stringify(decoded)}`,
    )
  }
  return decoded
}

function normalizedHostname(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`Static CloudFront log has invalid x-host-header ${JSON.stringify(value)}`)
  }
  const hostname = decoded.toLowerCase().replace(/\.$/, "")
  if (hostname === "" || hostname === "-") {
    throw new Error("Static CloudFront log has no viewer hostname")
  }
  return hostname
}

async function bodyBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null)
    throw new Error("Static CloudFront log object has no body")
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray()
    return Buffer.from(bytes)
  }

  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength
    if (bytes > MAX_COMPRESSED_BYTES) throw new Error("Static CloudFront log object is too large")
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, bytes)
}

async function decodedBody(body: unknown): Promise<string> {
  const compressed = await bodyBuffer(body)
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error("Static CloudFront log object is too large")
  }
  const decoded =
    compressed[0] === 0x1f && compressed[1] === 0x8b
      ? await gunzip(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
      : compressed
  if (decoded.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error("Static CloudFront log object expands beyond the importer limit")
  }
  return decoded.toString("utf8")
}

async function resolveStaticAttribution(
  db: Kysely<DB>,
  requests: ParsedRequest[],
): Promise<Map<string, Attribution>> {
  const hosts = [...new Set(requests.map((request) => request.hostname))]
  const routePrefixes = [
    ...new Set(
      requests.flatMap((request) => (request.routePrefix === null ? [] : [request.routePrefix])),
    ),
  ]
  const projectIds = routePrefixes.map((prefix) => prefix.slice(0, 36))
  const digests = routePrefixes.map((prefix) => prefix.slice(37))
  const projects =
    projectIds.length === 0
      ? []
      : await db
          .selectFrom("project")
          // Unlike hostname fallback, this is historical: the edge logged the immutable release
          // it served, so do not constrain the lookup to the project's current live pointer.
          .innerJoin("deployment", "deployment.projectId", "project.id")
          .select([
            "deployment.id as deploymentId",
            "deployment.staticDigest as staticDigest",
            "project.id as projectId",
            "project.organizationId as organizationId",
          ])
          .where("project.id", "in", projectIds)
          .where("deployment.staticDigest", "in", digests)
          .where("deployment.preset", "=", "static")
          // Re-publishing identical bytes creates the same edge prefix. Pick the newest matching
          // deployment deterministically when more than one control-plane row names that release.
          .orderBy("deployment.createdAt", "asc")
          .orderBy("deployment.id", "asc")
          .execute()
  const generated = await db
    .selectFrom("project")
    .innerJoin("deployment", "deployment.id", "project.liveDeploymentId")
    .select([
      "deployment.hostname as hostname",
      "deployment.id as deploymentId",
      "project.id as projectId",
      "project.organizationId as organizationId",
    ])
    .where("deployment.hostname", "in", hosts)
    .where("deployment.preset", "=", "static")
    .where("deployment.deletedAt", "is", null)
    .where("project.deletedAt", "is", null)
    .execute()
  const custom = await db
    .selectFrom("customDomain")
    .innerJoin("project", "project.id", "customDomain.projectId")
    .innerJoin("deployment", "deployment.id", "project.liveDeploymentId")
    .select([
      "customDomain.hostname as hostname",
      "deployment.id as deploymentId",
      "project.id as projectId",
      "project.organizationId as organizationId",
    ])
    .where("customDomain.hostname", "in", hosts)
    .where("customDomain.status", "=", "active")
    .where("customDomain.deletedAt", "is", null)
    .where("deployment.preset", "=", "static")
    .where("deployment.deletedAt", "is", null)
    .where("project.deletedAt", "is", null)
    .execute()

  return new Map([
    ...projects.map((row): [string, Attribution] => [
      `${row.projectId}/${row.staticDigest ?? ""}`,
      row,
    ]),
    ...generated.map((row): [string, Attribution] => [row.hostname!, row]),
    ...custom.map((row): [string, Attribution] => [row.hostname, row]),
  ])
}

export function staticCloudFrontUsageEvents(
  requests: ParsedRequest[],
  attribution: Map<string, Attribution>,
  objectKey: string,
): UsageEventRecord[] {
  return requests.flatMap((request) => {
    const owner =
      (request.routePrefix === null ? undefined : attribution.get(request.routePrefix)) ??
      attribution.get(request.hostname)
    if (owner === undefined) return []
    const common = {
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      resourceType: "deployment",
      resourceId: owner.deploymentId,
      occurredAt: request.occurredAt,
      ingestedAt: request.occurredAt,
      version: String(request.occurredAt.getTime()),
      windowStart: null,
      windowEnd: null,
      nodeId: null,
      podUid: null,
      source: SOURCE,
      chargedExternally: false,
      attributes: {
        cloudfront_request_id: request.requestId,
        deployment_id: owner.deploymentId,
        hostname: request.hostname,
        log_object_key: objectKey,
      },
    }
    return [
      usageEventRecord({
        ...common,
        dimension: "site_request",
        quantity: "1",
        externalId: `${request.requestId}:site_request`,
      }),
      usageEventRecord({
        ...common,
        dimension: "site_egress_byte",
        quantity: request.bytes,
        externalId: `${request.requestId}:site_egress_byte`,
      }),
    ]
  })
}

async function storeEvents(db: Kysely<DB>, events: UsageEventRecord[]): Promise<void> {
  for (let offset = 0; offset < events.length; offset += STATIC_CLOUDFRONT_OUTBOX_BATCH_SIZE) {
    const batch = events.slice(offset, offset + STATIC_CLOUDFRONT_OUTBOX_BATCH_SIZE)
    await crudMeteringOutbox(db).createMany(
      batch.map((event) => ({
        id: v7(),
        eventId: event.eventId,
        payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
      })),
    )
  }
}

/**
 * Fetch one immutable object and stage retry-stable request and egress events in the outbox.
 *
 * FUTURE: if seconds-level visibility becomes necessary, replace this standard-log source with
 * 100% CloudFront real-time logs through Kinesis and a checkpointed consumer. Sampling cannot be
 * used for billing, and cache hits must remain on CloudFront instead of being routed through Rust.
 */
export function importStaticCloudFrontLog(dependencies: ImportDependencies = {}): JobHandler {
  let client: S3Client | undefined
  const get =
    dependencies.get ??
    (async (input) => {
      client ??= s3Client()
      return await client.send(new GetObjectCommand(input))
    })

  return async (job, { db }) => {
    const config = dependencies.config ?? configFromEnv()
    const payload = job.payload as { key?: unknown; etag?: unknown }
    if (typeof payload.key !== "string" || typeof payload.etag !== "string") {
      throw new Error("Static CloudFront log import requires key and etag")
    }
    if (!payload.key.startsWith(config.prefix) || payload.key.endsWith("/")) {
      throw new Error("Static CloudFront log import key is outside the configured prefix")
    }

    const object = await get({ Bucket: config.bucket, Key: payload.key, IfMatch: payload.etag })
    const requests = parseStaticCloudFrontLog(await decodedBody(object.Body))
    const attribution = await (dependencies.resolveAttribution ?? resolveStaticAttribution)(
      db,
      requests,
    )
    const events = staticCloudFrontUsageEvents(requests, attribution, payload.key)
    await (dependencies.storeEvents ?? storeEvents)(db, events)

    const unmatched = requests.length - events.length / 2
    if (unmatched > 0) {
      console.warn(
        `[jobs] skipped ${unmatched} unattributed static CloudFront request(s) in ${payload.key}`,
      )
    }
    if (events.length > 0) {
      console.info(
        `[jobs] staged ${events.length} static CloudFront usage event(s) from ${payload.key}`,
      )
    }
  }
}

function integerQuantity(value: string, label: string): bigint {
  if (!/^\d+(?:\.0+)?$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer quantity, received ${value}`)
  }
  return BigInt(value.split(".")[0] ?? value)
}

function providerMetricTotal(value: number | undefined, label: string): string {
  if (value === undefined) return "0"
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`CloudFront ${label} metric is invalid: ${String(value)}`)
  }
  return String(Math.round(value))
}

async function cloudFrontProviderTotals(
  distributionId: string,
  start: Date,
  end: Date,
): Promise<ReconciliationTotals> {
  const client = new CloudWatchClient({ region: "us-east-1" })
  const response = await client.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/CloudFront",
      MetricName: "Requests",
      Dimensions: [
        { Name: "DistributionId", Value: distributionId },
        { Name: "Region", Value: "Global" },
      ],
      StartTime: start,
      EndTime: end,
      Period: 86_400,
      Statistics: ["Sum"],
    }),
  )
  return {
    requests: providerMetricTotal(
      response.Datapoints?.reduce((sum, point) => sum + (point.Sum ?? 0), 0),
      "Requests",
    ),
  }
}

function closedUtcDay(now: Date, daysAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo))
}

/**
 * Compare the provider request count with canonical ClickHouse rows without manufacturing usage.
 *
 * AWS defines both the CloudWatch Requests metric and one standard-log row as a viewer request
 * across all methods, so those counts have a bounded, like-for-like interpretation. We
 * intentionally do not compare bytes: standard-log sc-bytes includes response headers and all
 * methods, while BytesDownloaded is defined only for GET and HEAD and AWS does not document those
 * values as equivalent. A byte comparison here would manufacture a false residual.
 *
 * Standard logs are best effort. During the documented delivery window a positive request gap is
 * `pending_delivery`; after the grace period it becomes `platform_overhead`. Neither state writes
 * a usage event, rollup, hold, or ledger entry. Credit enforcement therefore never treats usage
 * that has not been attributed yet as a customer debit, and the prepaid hard floor remains the
 * only last-line safeguard.
 *
 * FUTURE: if seconds-level visibility becomes necessary, replace standard logs with 100% real-time
 * logs through Kinesis and a checkpointed consumer. Never sample a financial source, and do not
 * route static cache hits through Rust merely to meter them.
 */
export function reconcileStaticCloudFrontUsage(
  dependencies: ReconciliationDependencies = {},
): JobHandler {
  return async (_job, { db, keepAlive, signal }) => {
    const now = dependencies.now?.() ?? new Date()
    if (Number.isNaN(now.getTime())) throw new Error("Static reconciliation clock is invalid")
    const distributionId = dependencies.distributionId ?? process.env.TENANT_STATIC_DISTRIBUTION_ID
    if (distributionId === undefined || distributionId === "") {
      throw new Error(
        "TENANT_STATIC_DISTRIBUTION_ID is not set; provider usage cannot be reconciled",
      )
    }
    const providerTotals =
      dependencies.providerTotals ??
      ((start: Date, end: Date) => cloudFrontProviderTotals(distributionId, start, end))
    const importedTotals = dependencies.importedTotals ?? staticCloudFrontUsageTotals
    const store =
      dependencies.store ??
      (async (database, input) => {
        await crudProviderUsageReconciliation(database).upsert({
          id: v7(),
          provider: "cloudfront",
          ...input,
        })
      })

    for (let daysAgo = 1; daysAgo <= STATIC_CLOUDFRONT_RECONCILIATION_DAYS; daysAgo++) {
      if (signal.aborted) throw signal.reason ?? new Error("Static reconciliation aborted")
      const start = closedUtcDay(now, daysAgo)
      const end = new Date(start.getTime() + 86_400_000)
      const [provider, imported] = await Promise.all([
        providerTotals(start, end),
        importedTotals(start, end),
      ])
      const providerRequests = integerQuantity(provider.requests, "provider requests")
      const importedRequests = integerQuantity(imported.requests, "imported requests")
      const residualRequests =
        providerRequests > importedRequests ? providerRequests - importedRequests : 0n
      const hasResidual = residualRequests > 0n
      const graceEnds = new Date(end.getTime() + STATIC_CLOUDFRONT_DELIVERY_GRACE_HOURS * 3_600_000)
      const status = !hasResidual
        ? "matched"
        : now < graceEnds
          ? "pending_delivery"
          : "platform_overhead"

      await store(db, {
        importedRequests: importedRequests.toString(),
        observedAt: now,
        periodStart: start,
        providerRequests: providerRequests.toString(),
        residualRequests: residualRequests.toString(),
        resourceId: distributionId,
        status,
      })

      console.info(
        JSON.stringify({
          event: "static_cloudfront_usage_reconciliation",
          periodStart: start.toISOString(),
          providerRequests: providerRequests.toString(),
          importedRequests: importedRequests.toString(),
          residualRequests: residualRequests.toString(),
          comparisonSemantics: "viewer_request_count_only",
          byteComparison: "unsupported_non_equivalent_definitions",
          residualAllocation: "platform_overhead",
          status,
        }),
      )
      if (!(await keepAlive())) throw new Error("Static reconciliation lost its job lease")
    }
  }
}
