import {
  ingestLogs,
  MalformedOtlpError,
  observabilityConfigured,
  resolveIngestKey,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"

/**
 * The OTLP/HTTP ingest endpoint (TASK 34).
 *
 * **Unauthenticated by session, on purpose.** The caller is a customer's own process — a container,
 * a Lambda, an OTel Collector — which has an ingest key and no notion of a browser session. It
 * authenticates with `Authorization: Bearer sos_ing_…`, which is what `OTEL_EXPORTER_OTLP_HEADERS`
 * can carry.
 *
 * The path is `/v1/otlp/v1/logs` rather than something of our own: an OTel exporter appends
 * `/v1/logs` to whatever endpoint it is given, so the configuration a customer writes is
 * `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.sproutos.dev/v1/otlp` and nothing else. Inventing a path
 * would mean every customer having to set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` explicitly, which is
 * the setting people get wrong.
 */
const otlp: Hono = new Hono()

/**
 * The largest body this will read.
 *
 * An OTel exporter's default batch is 512 records and its payloads are kilobytes. This bounds what
 * one request — from a caller who has not been authenticated yet — can make the process allocate.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** OTLP's own error shape. An exporter logs `message`; anything else is opaque to it. */
function otlpError(status: 400 | 401 | 413 | 415 | 429 | 503, message: string) {
  return Response.json({ code: status, message }, { status })
}

otlp.post(
  "/v1/logs",
  describeRoute({
    description: "OTLP/HTTP log ingest. Authenticated with a project ingest key.",
    // Hidden from the generated client: the caller is a customer's OTel exporter, not our frontend,
    // and a typed method for it in the dashboard SDK would only ever be dead code.
    hide: true,
  }),
  async (c) => {
    if (!observabilityConfigured()) {
      return otlpError(503, "Log ingest is not configured on this deployment")
    }

    const authorization = c.req.header("authorization") ?? ""
    const key = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : ""
    if (key === "") {
      return otlpError(401, "Missing ingest key. Send Authorization: Bearer <key>.")
    }

    /*
      Content type is checked before the body is read.

      An exporter defaults to protobuf (`application/x-protobuf`) and has to be told to send JSON.
      Refusing it with a clear message beats letting `c.req.json()` fail on binary and returning
      something that reads like a bug in the customer's code.
    */
    const contentType = c.req.header("content-type") ?? ""
    if (!contentType.includes("json")) {
      return otlpError(
        415,
        "Only application/json is accepted. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json.",
      )
    }

    const declared = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return otlpError(413, `Batches are limited to ${MAX_BODY_BYTES} bytes`)
    }

    const raw = await c.req.text()
    if (raw.length > MAX_BODY_BYTES) {
      // Checked again on the actual bytes: `Content-Length` is the client's claim, and a chunked
      // request does not send one at all.
      return otlpError(413, `Batches are limited to ${MAX_BODY_BYTES} bytes`)
    }

    // Resolved *after* the cheap checks and *before* parsing, so an unauthenticated caller never
    // makes us parse megabytes of JSON.
    const stream = await resolveIngestKey(db, key)
    if (stream === undefined) return otlpError(401, "Unknown or revoked ingest key")

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return otlpError(400, "The body is not valid JSON")
    }

    try {
      const result = await ingestLogs(stream, payload, raw.length)

      /*
        OTLP's partial-success shape, and it is not optional.

        A server that drops records and returns a bare 200 leaves the exporter with no way to know
        its telemetry is not arriving — a bad failure for a product whose job is telling you what
        happened. `rejectedLogRecords` is a string because it is an int64 in the protobuf.
      */
      return c.json(
        result.rejected > 0
          ? {
              partialSuccess: {
                rejectedLogRecords: String(result.rejected),
                errorMessage: result.message ?? "",
              },
            }
          : {},
      )
    } catch (cause) {
      if (cause instanceof MalformedOtlpError) return otlpError(400, cause.message)
      throw cause
    }
  },
)

export default otlp
