import type { UsageBatch, UsageEvent } from "./canonical"

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
  if (typeof dimension !== "string") return "dimension must be a string"
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
  if (parsedAttributes === undefined) return "attributes must be a flat string map"

  return {
    externalId,
    organizationId,
    projectId: typeof projectId === "string" ? projectId : null,
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
