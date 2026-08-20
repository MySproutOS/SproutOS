import { SrnParseError, type SrnSegmentKind } from "./errors"

/** Every SRN starts with this literal. */
export const SRN_PREFIX = "srn:sproutos:"

/** The segment that means "any". */
export const WILDCARD = "*"

/** Longest SRN the parser will look at, in bytes. */
export const MAX_SRN_LEN = 512

const encoder = new TextEncoder()

/** The `<type>/<id>` tail of an SRN. */
export type SrnResource =
  | { readonly kind: "any" }
  | { readonly kind: "typed"; readonly resourceType: string; readonly id: string }

/** A parsed SproutOS Resource Name. Every `Srn` that exists is well-formed. */
export interface Srn {
  readonly service: string
  readonly organizationId: string
  readonly resource: SrnResource
}

/**
 * An SRN read as a matching pattern.
 *
 * Structurally identical to an [[Srn]] and kept as a distinct type on purpose: only the pattern
 * side expands wildcards, so handing a target where a pattern is expected is a security bug.
 */
export interface SrnPattern {
  readonly srn: Srn
}

const ANY_RESOURCE: SrnResource = { kind: "any" }

function isTokenCharacter(code: number): boolean {
  const lowercase = code >= 0x61 && code <= 0x7a
  const digit = code >= 0x30 && code <= 0x39
  const punctuation = code === 0x2e || code === 0x5f || code === 0x2d
  return lowercase || digit || punctuation
}

function validateSegment(segment: string, kind: SrnSegmentKind, input: string): void {
  if (segment.length === 0) {
    throw new SrnParseError({ kind: "empty-segment", segment: kind }, input)
  }
  if (segment === WILDCARD) return
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0
    if (!isTokenCharacter(code)) {
      throw new SrnParseError({ kind: "illegal-character", segment: kind, character }, input)
    }
  }
}

function parseResource(raw: string, input: string): SrnResource {
  if (raw.length === 0) {
    throw new SrnParseError({ kind: "empty-segment", segment: "resource" }, input)
  }
  if (raw === WILDCARD) return ANY_RESOURCE

  const halves = raw.split("/")
  if (halves.length !== 2) {
    throw new SrnParseError({ kind: "malformed-resource", found: raw }, input)
  }

  const [resourceType, id] = halves
  validateSegment(resourceType, "resource type", input)
  validateSegment(id, "resource id", input)
  return { kind: "typed", resourceType, id }
}

/** Parses a concrete SRN, throwing [[SrnParseError]] when the string is not one. */
export function parseSrn(input: string): Srn {
  const byteLength = encoder.encode(input).length
  if (byteLength > MAX_SRN_LEN) {
    throw new SrnParseError({ kind: "too-long", length: byteLength, max: MAX_SRN_LEN }, input)
  }

  const segments = input.split(":")
  if (segments.length !== 5) {
    throw new SrnParseError({ kind: "segment-count", found: segments.length }, input)
  }
  if (segments[0] !== "srn" || segments[1] !== "sproutos") {
    throw new SrnParseError({ kind: "wrong-prefix" }, input)
  }

  validateSegment(segments[2], "service", input)
  validateSegment(segments[3], "organization", input)
  const resource = parseResource(segments[4], input)

  return { service: segments[2], organizationId: segments[3], resource }
}

/** Parses a concrete SRN, returning `null` instead of throwing. */
export function tryParseSrn(input: string): Srn | null {
  try {
    return parseSrn(input)
  } catch {
    return null
  }
}

/** Parses an SRN read as a pattern. Same grammar, different matching role. */
export function parseSrnPattern(input: string): SrnPattern {
  return { srn: parseSrn(input) }
}

/** Parses an SRN pattern, returning `null` instead of throwing. */
export function tryParseSrnPattern(input: string): SrnPattern | null {
  const srn = tryParseSrn(input)
  return srn === null ? null : { srn }
}

/** Whether `input` parses as an SRN under this grammar. */
export function isSrn(input: string): boolean {
  return tryParseSrn(input) !== null
}

export function formatSrnResource(resource: SrnResource): string {
  return resource.kind === "any" ? WILDCARD : `${resource.resourceType}/${resource.id}`
}

/** Renders an SRN back to its string form. Round-trips byte for byte through [[parseSrn]]. */
export function formatSrn(srn: Srn): string {
  return `${SRN_PREFIX}${srn.service}:${srn.organizationId}:${formatSrnResource(srn.resource)}`
}

export function formatSrnPattern(pattern: SrnPattern): string {
  return formatSrn(pattern.srn)
}

/** Whether any segment of this SRN is a wildcard. */
export function containsWildcard(srn: Srn): boolean {
  if (srn.service === WILDCARD || srn.organizationId === WILDCARD) return true
  if (srn.resource.kind === "any") return true
  return srn.resource.resourceType === WILDCARD || srn.resource.id === WILDCARD
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The organization segment as a UUID, or `null` when it is `*` or not a UUID.
 *
 * The grammar itself is syntactic: it does not require the organization segment to be a UUID,
 * because callers that care resolve it against the database anyway.
 */
export function organizationUuid(srn: Srn): string | null {
  return UUID_PATTERN.test(srn.organizationId) ? srn.organizationId : null
}

function segmentMatches(pattern: string, target: string): boolean {
  return pattern === WILDCARD || pattern === target
}

/** Whether `pattern` covers `target`. Wildcards expand on the pattern side only. */
export function srnPatternMatches(pattern: SrnPattern, target: Srn): boolean {
  if (!segmentMatches(pattern.srn.service, target.service)) return false
  if (!segmentMatches(pattern.srn.organizationId, target.organizationId)) return false

  const patternResource = pattern.srn.resource
  const targetResource = target.resource
  if (patternResource.kind === "any") return true
  if (targetResource.kind === "any") return false
  return (
    segmentMatches(patternResource.resourceType, targetResource.resourceType) &&
    segmentMatches(patternResource.id, targetResource.id)
  )
}

/** Whether any pattern in `patterns` covers `target`. */
export function anySrnPatternMatches(patterns: readonly SrnPattern[], target: Srn): boolean {
  return patterns.some((pattern) => srnPatternMatches(pattern, target))
}

/** String-level convenience over [[srnPatternMatches]]. Unparsable input never matches. */
export function srnMatches(pattern: string, target: string): boolean {
  const parsedPattern = tryParseSrnPattern(pattern)
  const parsedTarget = tryParseSrn(target)
  if (parsedPattern === null || parsedTarget === null) return false
  return srnPatternMatches(parsedPattern, parsedTarget)
}

/**
 * Every pattern string that would match `target`, and no others.
 *
 * A grant is stored as a pattern in a `text[]` column, so the only way to ask Postgres "does any
 * stored pattern cover this target" with an index is to turn the question around: enumerate the
 * finite set of patterns that could cover the target and test array overlap. Segment counts are
 * fixed, so the set is at most twenty strings.
 */
export function expandSrnTarget(target: Srn): string[] {
  const services = target.service === WILDCARD ? [WILDCARD] : [target.service, WILDCARD]
  const organizations =
    target.organizationId === WILDCARD ? [WILDCARD] : [target.organizationId, WILDCARD]
  const resources: string[] = [WILDCARD]

  if (target.resource.kind === "typed") {
    const { resourceType, id } = target.resource
    const types = resourceType === WILDCARD ? [WILDCARD] : [resourceType, WILDCARD]
    const ids = id === WILDCARD ? [WILDCARD] : [id, WILDCARD]
    for (const type of types) {
      for (const candidate of ids) {
        resources.push(`${type}/${candidate}`)
      }
    }
  }

  const expanded: string[] = []
  for (const service of services) {
    for (const organization of organizations) {
      for (const resource of resources) {
        expanded.push(`${SRN_PREFIX}${service}:${organization}:${resource}`)
      }
    }
  }
  return expanded
}

/** [[expandSrnTarget]] over a target that has not been parsed yet. */
export function expandSrnTargetString(target: string): string[] {
  return expandSrnTarget(parseSrn(target))
}
