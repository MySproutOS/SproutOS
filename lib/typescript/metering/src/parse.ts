import type { UsageBatch, UsageEvent } from "./canonical"
import { isBillableDimension } from "./dimensions"

/**
 * Turn the wire JSON into a batch, or say why not.
 *
 * Separate from verification on purpose. The signature is computed over values *as parsed*, so
 * parsing has to happen first — which means a malformed batch is rejected before any comparison and
 * cannot be used to probe the verifier.
 *
 * Every field is checked rather than cast. An event with a missing `organization_id` that reached
 * the database would be usage attributed to nobody, and the row would sit there looking like data.
 */
export type ParsedBatch = { ok: true; batch: UsageBatch } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function attributesOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined

  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    // Exact parity with Rust's `UsageBatch::validate`. These keys become operational labels and
    // ClickHouse map keys, so accepting a second vocabulary here would make a Rust-built batch
    // valid or invalid depending on which side happened to inspect it first.
    if (!/^[a-z0-9._-]+$/.test(key)) return undefined
    // Not coerced. `String(entry)` on an object gives "[object Object]", which signs cleanly and
    // means nothing.
    if (typeof entry !== "string") return undefined
    out[key] = entry
  }
  return out
}

function eventFrom(value: unknown): UsageEvent | string {
  if (!isRecord(value)) return "event is not an object"

  const {
    external_id: externalId,
    organization_id: organizationId,
    project_id: projectId,
    charged_externally: chargedExternally,
    dimension,
    quantity,
    occurred_at: occurredAt,
    attributes,
  } = value

  if (typeof externalId !== "string" || externalId === "") return "external_id must be a string"
  if (typeof organizationId !== "string") return "organization_id must be a string"
  if (projectId !== null && projectId !== undefined && typeof projectId !== "string") {
    return "project_id must be a string or null"
  }
  if (chargedExternally !== undefined && typeof chargedExternally !== "boolean") {
    return "charged_externally must be a boolean when present"
  }
  if (!isBillableDimension(dimension)) return "dimension must be a current billable dimension"
  // `Number.isFinite` rather than `typeof === "number"`: NaN and the infinities are numbers, they
  // round-trip through JSON as `null`, and they bill as garbage.
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return "quantity must be a finite number"
  }
  if (quantity < 0) return "quantity must not be negative"
  if (typeof occurredAt !== "number" || !Number.isInteger(occurredAt)) {
    return "occurred_at must be an integer"
  }

  const parsedAttributes = attributesOf(attributes)
  if (parsedAttributes === undefined) {
    return "attributes must be a flat string map with keys matching [a-z0-9._-]+"
  }

  return {
    externalId,
    organizationId,
    projectId: typeof projectId === "string" ? projectId : null,
    ...(chargedExternally === undefined ? {} : { chargedExternally }),
    dimension,
    quantity,
    occurredAt,
    attributes: parsedAttributes,
  }
}

export function parseBatch(raw: unknown): ParsedBatch {
  if (!isRecord(raw)) return { ok: false, reason: "batch is not an object" }
  if (typeof raw.source !== "string" || raw.source === "") {
    return { ok: false, reason: "source must be a non-empty string" }
  }
  if (!Array.isArray(raw.events)) return { ok: false, reason: "events must be an array" }

  const events: UsageEvent[] = []
  for (const [index, candidate] of raw.events.entries()) {
    const parsed = eventFrom(candidate)
    if (typeof parsed === "string") return { ok: false, reason: `events[${index}]: ${parsed}` }
    events.push(parsed)
  }

  return { ok: true, batch: { source: raw.source, events } }
}
