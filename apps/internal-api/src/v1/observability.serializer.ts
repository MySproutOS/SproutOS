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
  /** OTel severity number: 9 INFO, 13 WARN, 17 ERROR. */
  minSeverity: Type.Optional(Type.String()),
  service: Type.Optional(Type.String({ maxLength: 200 })),
  traceId: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.String()),
  /** A `nextBefore` from a previous page. */
  before: Type.Optional(Type.String({ maxLength: 32 })),
})

export const observabilitySchemaLogLine = Type.Object({
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
