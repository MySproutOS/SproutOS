import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const observabilitySchemaProjectParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
})

export const observabilitySchemaLogQuery = Type.Object({
  /** ISO 8601. Defaults to an hour ago, which is what a log page opens on. */
  since: Type.Optional(Type.String()),
  until: Type.Optional(Type.String()),
  search: Type.Optional(Type.String({ maxLength: 500 })),
  /**
   * One of the levels `levelOf()` derives from a runtime line: `platform`, `trace`, `debug`,
   * `info`, `warn`, `error`, `fatal`. An exact match rather than a minimum, because these come
   * from parsing the customer's own output and there is no ordering to be confident about.
   */
  level: Type.Optional(Type.String({ maxLength: 16 })),
  /** Narrow to one invocation. Lambda's request id, as it appears on the runtime's own lines. */
  requestId: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.String()),
  /** A `nextBefore` from a previous page. */
  before: Type.Optional(Type.String({ maxLength: 32 })),
})

/*
  A line as the platform observed it, which is what a customer means by "my logs".

  This was the OpenTelemetry log model — `severityNumber`, `traceId`, `spanId`, `scopeName`,
  `attributes` — and it described `log_record`, the table a customer's own OTel exporter writes
  into. Almost nobody has one, so the page showed "Nothing sent yet" while `runtime_log` held the
  output of their function, collected automatically and expiring in three days unseen.

  The fields here are Lambda's own. `durationMs` and the rest are null on ordinary output and
  populated on the `REPORT` line that closes each invocation, which is where a per-request cost
  and a cold start become visible.
*/
export const observabilitySchemaLogLine = Type.Object({
  timestamp: Type.String(),
  cursor: Type.String(),
  level: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  deploymentId: Type.String(),
  durationMs: Nullable(Type.Number()),
  billedMs: Nullable(Type.Integer()),
  memoryMb: Nullable(Type.Integer()),
  initMs: Nullable(Type.Number()),
  coldStart: Nullable(Type.Boolean()),
})

/*
  The OpenTelemetry line, which is a different table and a different shape.

  Kept beside the runtime one rather than unified into it. `log_record` carries `trace_id`,
  `span_id` and two attribute maps that a runtime line has no equivalent for, and `runtime_log`
  carries Lambda's billing fields that an OTel record has nowhere to put. Merging them would mean
  every column nullable and a reader that cannot tell which half is meaningful.
*/
export const observabilitySchemaOtlpLine = Type.Object({
  timestamp: Type.String(),
  cursor: Type.String(),
  severityNumber: Type.Integer(),
  severityText: Type.String(),
  body: Type.String(),
  serviceName: Type.String(),
  scopeName: Type.String(),
  traceId: Type.String(),
  spanId: Type.String(),
  attributes: Type.Record(Type.String(), Type.String()),
})

export const observabilitySchemaOtlpResponse = Type.Object({
  lines: Type.Array(observabilitySchemaOtlpLine),
  nextBefore: Nullable(Type.String()),
})

/** Query parameters for the OTLP source, which filters on severity rather than a parsed level. */
export const observabilitySchemaOtlpQuery = Type.Object({
  since: Type.Optional(Type.String()),
  until: Type.Optional(Type.String()),
  search: Type.Optional(Type.String({ maxLength: 200 })),
  /** OTel severity number: 9 INFO, 13 WARN, 17 ERROR. A floor, unlike the runtime level. */
  minSeverity: Type.Optional(Type.String()),
  service: Type.Optional(Type.String({ maxLength: 200 })),
  traceId: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.String()),
  before: Type.Optional(Type.String({ maxLength: 32 })),
})

export const observabilitySchemaLogsResponse = Type.Object({
  lines: Type.Array(observabilitySchemaLogLine),
  nextBefore: Nullable(Type.String()),
})

export const observabilitySchemaStreamResponse = Type.Object({
  /** Null until the project has been given an ingest key. */
  streamId: Nullable(UUID7String),
  retentionDays: Type.Integer(),
  /** Where a customer points `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint: Type.String(),
  services: Type.Array(Type.String()),
  usage: Type.Object({
    records: Type.Integer(),
    bytes: Type.Integer(),
  }),
})

export const observabilitySchemaKeyRequest = Type.Object({
  retentionDays: Type.Optional(Type.Union([Type.Literal(7), Type.Literal(30), Type.Literal(90)])),
})

/**
 * The key is returned **once**.
 *
 * It is stored as a one-way hash, so there is no "show it to me again": rotating is the only way
 * back, and rotating invalidates the old key. That is what makes it a recovery from a leak rather
 * than a convenience, and the response says so rather than leaving a caller to discover it.
 */
export const observabilitySchemaKeyResponse = Type.Object({
  key: Type.String(),
  streamId: UUID7String,
  endpoint: Type.String(),
  retentionDays: Type.Integer(),
})
